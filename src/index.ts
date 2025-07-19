#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { validateWorkflow } from '@action-validator/core';
import * as YAML from 'yaml';
import { logger } from './logger.js';

const ConfigSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  token: z.string(),
});

const ExecuteWorkflowArgsSchema = z.object({
  workflow_yaml: z.string().optional(),
  workflow_path: z.string().optional(),
  branch_name: z.string().optional(),
});

interface Config {
  owner: string;
  repo: string;
  token: string;
}

class GitHubActionsWorkflowServer {
  private server: Server;
  private octokit: Octokit;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    logger.info('Initializing GitHub Actions Workflow Server', {
      owner: config.owner,
      repo: config.repo,
      tokenLength: config.token.length,
    });

    this.octokit = new Octokit({ auth: config.token });
    this.server = new Server(
      {
        name: 'execute-github-actions-workflow',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    logger.info('Server initialized successfully');
  }

  private setupHandlers() {
    logger.debug('Setting up request handlers');

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const startTime = Date.now();
      logger.logRequest(request.params.name, request.params.arguments);

      try {
        if (request.params.name === 'execute_github_actions_workflow') {
          const result = await this.executeWorkflow(request.params.arguments);
          const duration = Date.now() - startTime;
          logger.logResponse(request.params.name, duration, true);
          return result;
        }

        const error = new Error(`Unknown tool: ${request.params.name}`);
        logger.error('Unknown tool requested', error, { toolName: request.params.name });
        throw error;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.logResponse(request.params.name, duration, false);
        logger.error('Request failed', error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'execute_github_actions_workflow',
          description:
            "Validate, mutate trigger to 'push', re-validate, and execute a GitHub Actions workflow by pushing it to a new branch and monitoring the run",
          inputSchema: {
            type: 'object',
            properties: {
              workflow_yaml: {
                type: 'string',
                description:
                  'The YAML content of the workflow file (required if workflow_path is not provided)',
              },
              workflow_path: {
                type: 'string',
                description:
                  'Path to an existing workflow file (required if workflow_yaml is not provided)',
              },
              branch_name: {
                type: 'string',
                description:
                  'Custom branch name for the workflow execution (optional, defaults to auto-generated)',
              },
            },
            required: [],
          },
        },
      ],
    }));
  }

  private async validateWorkflowYaml(
    workflowContent: string,
    type: 'original' | 'mutated' = 'original'
  ): Promise<void> {
    logger.debug(`Starting workflow validation (${type})`, {
      contentLength: workflowContent.length,
    });

    try {
      const state = validateWorkflow(workflowContent);

      if (state.errors.length > 0) {
        logger.logValidation(type, false, state.errors.length);
        const errorMessages = state.errors
          .map(error => `${error.title}: ${error.detail || error.code}`)
          .join('\n');

        logger.error(`Workflow validation failed (${type})`, undefined, {
          errorCount: state.errors.length,
          errors: state.errors,
        });

        throw new Error(`Workflow validation failed:\n${errorMessages}`);
      }

      logger.logValidation(type, true, 0);
      logger.debug(`Workflow validation passed (${type})`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Workflow validation failed')) {
        throw error;
      }

      logger.error(
        `Failed to validate workflow YAML (${type})`,
        error instanceof Error ? error : new Error(String(error))
      );
      throw new Error(`Failed to validate workflow YAML: ${error}`);
    }
  }

  private mutateWorkflowTrigger(workflowContent: string): string {
    logger.debug('Starting workflow trigger mutation');

    try {
      const workflow = YAML.parse(workflowContent);

      if (!workflow || typeof workflow !== 'object') {
        const error = new Error('Invalid workflow YAML structure');
        logger.error('Workflow mutation failed: invalid YAML structure', error);
        throw error;
      }

      const originalTrigger = workflow.on;
      // Set the trigger to push to ensure the workflow runs when we push to the branch
      workflow.on = 'push';

      const mutatedContent = YAML.stringify(workflow);

      logger.info('Workflow trigger mutated successfully', {
        originalTrigger: JSON.stringify(originalTrigger),
        newTrigger: 'push',
        originalLength: workflowContent.length,
        mutatedLength: mutatedContent.length,
      });

      return mutatedContent;
    } catch (error) {
      logger.error(
        'Failed to mutate workflow trigger',
        error instanceof Error ? error : new Error(String(error))
      );
      throw new Error(`Failed to mutate workflow trigger: ${error}`);
    }
  }

  private async executeWorkflow(args: unknown) {
    logger.info('Starting workflow execution', { args });

    const parsed = ExecuteWorkflowArgsSchema.parse(args);
    logger.debug('Parsed workflow arguments', { parsed });

    if (!parsed.workflow_yaml && !parsed.workflow_path) {
      const error = new Error('Either workflow_yaml or workflow_path must be provided');
      logger.error('Invalid arguments: missing workflow content', error);
      throw error;
    }

    let workflowContent: string;

    if (parsed.workflow_yaml) {
      workflowContent = parsed.workflow_yaml;
      logger.info('Using provided workflow YAML', { contentLength: workflowContent.length });
    } else {
      try {
        logger.debug('Reading workflow from file', { path: parsed.workflow_path });
        const fs = await import('fs/promises');
        workflowContent = await fs.readFile(parsed.workflow_path!, 'utf-8');
        logger.info('Successfully read workflow file', {
          path: parsed.workflow_path,
          contentLength: workflowContent.length,
        });
      } catch (error) {
        logger.error(
          'Failed to read workflow file',
          error instanceof Error ? error : new Error(String(error)),
          {
            path: parsed.workflow_path,
          }
        );
        throw new Error(`Failed to read workflow file: ${error}`);
      }
    }

    // Validate the original workflow YAML
    logger.logWorkflowExecution('validating-original', 'N/A');
    await this.validateWorkflowYaml(workflowContent, 'original');

    // Mutate the workflow to ensure it has a push trigger
    logger.logWorkflowExecution('mutating-trigger', 'N/A');
    const mutatedWorkflowContent = this.mutateWorkflowTrigger(workflowContent);

    // Re-validate the mutated workflow
    logger.logWorkflowExecution('validating-mutated', 'N/A');
    await this.validateWorkflowYaml(mutatedWorkflowContent, 'mutated');

    const branchName = parsed.branch_name || `mcp-workflow-${Date.now()}`;
    const workflowFileName = '.github/workflows/mcp-executed-workflow.yml';
    let branchCreated = false;

    logger.info('Workflow processing complete, starting GitHub operations', {
      branchName,
      workflowFileName,
      owner: this.config.owner,
      repo: this.config.repo,
    });

    try {
      // Get default branch
      logger.logGitHubAPI('get-repository', this.config.owner, this.config.repo);
      const { data: repo } = await this.octokit.repos.get({
        owner: this.config.owner,
        repo: this.config.repo,
      });
      const defaultBranch = repo.default_branch;
      logger.info('Retrieved repository information', {
        defaultBranch,
        repoId: repo.id,
        private: repo.private,
      });

      // Get the SHA of the default branch
      logger.logGitHubAPI('get-ref', this.config.owner, this.config.repo, {
        ref: `heads/${defaultBranch}`,
      });
      const { data: ref } = await this.octokit.git.getRef({
        owner: this.config.owner,
        repo: this.config.repo,
        ref: `heads/${defaultBranch}`,
      });
      logger.debug('Retrieved default branch SHA', { sha: ref.object.sha, ref: ref.ref });

      // Create new branch
      logger.logGitHubAPI('create-ref', this.config.owner, this.config.repo, {
        newBranch: branchName,
        fromSha: ref.object.sha,
      });
      logger.logWorkflowExecution('creating-branch', branchName);

      await this.octokit.git.createRef({
        owner: this.config.owner,
        repo: this.config.repo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
      branchCreated = true;
      logger.info('Branch created successfully', { branchName, sha: ref.object.sha });

      // Check if .github/workflows directory exists (for future use if needed)
      logger.debug('Checking if .github directory exists');
      try {
        await this.octokit.repos.getContent({
          owner: this.config.owner,
          repo: this.config.repo,
          path: '.github',
          ref: branchName,
        });
        logger.debug('.github directory exists');
      } catch {
        logger.debug('.github directory does not exist, will be created when needed');
      }

      // Create or update the workflow file with mutated content
      const content = Buffer.from(mutatedWorkflowContent).toString('base64');
      logger.logGitHubAPI('create-file', this.config.owner, this.config.repo, {
        path: workflowFileName,
        branch: branchName,
        contentSize: content.length,
      });
      logger.logWorkflowExecution('pushing-workflow', branchName);

      await this.octokit.repos.createOrUpdateFileContents({
        owner: this.config.owner,
        repo: this.config.repo,
        path: workflowFileName,
        message: `Add MCP executed workflow`,
        content,
        branch: branchName,
      });
      logger.info('Workflow file pushed successfully', {
        path: workflowFileName,
        branch: branchName,
      });

      // Wait a moment for GitHub to process the new workflow
      logger.debug('Waiting for GitHub to process workflow file');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get workflow runs for this branch
      logger.logGitHubAPI('list-workflow-runs', this.config.owner, this.config.repo, {
        branch: branchName,
      });
      logger.logWorkflowExecution('checking-runs', branchName);

      const { data: workflowRuns } = await this.octokit.actions.listWorkflowRunsForRepo({
        owner: this.config.owner,
        repo: this.config.repo,
        branch: branchName,
        per_page: 1,
      });

      logger.info('Retrieved workflow runs', {
        runCount: workflowRuns.workflow_runs.length,
        totalCount: workflowRuns.total_count,
      });

      if (workflowRuns.workflow_runs.length === 0) {
        const error = new Error(
          'No workflow run was triggered. Check if the workflow YAML is valid and has appropriate triggers.'
        );
        logger.error('No workflow run triggered', error, { branch: branchName });
        throw error;
      }

      const workflowRun = workflowRuns.workflow_runs[0];
      logger.info('Found workflow run', {
        runId: workflowRun.id,
        status: workflowRun.status,
        conclusion: workflowRun.conclusion,
        htmlUrl: workflowRun.html_url,
      });

      // Poll for completion
      logger.logWorkflowExecution('polling-completion', branchName, { runId: workflowRun.id });
      const result = await this.pollWorkflowCompletion(workflowRun.id);

      logger.info('Workflow execution completed successfully', {
        runId: workflowRun.id,
        finalStatus: result.status,
        finalConclusion: result.conclusion,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } finally {
      // Cleanup: always attempt to delete the branch if it was created
      if (branchCreated) {
        logger.logWorkflowExecution('cleaning-up', branchName);
        try {
          logger.logGitHubAPI('delete-ref', this.config.owner, this.config.repo, {
            ref: `heads/${branchName}`,
          });
          await this.octokit.git.deleteRef({
            owner: this.config.owner,
            repo: this.config.repo,
            ref: `heads/${branchName}`,
          });
          logger.logCleanup(branchName, true);
        } catch (cleanupError) {
          const error =
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
          logger.logCleanup(branchName, false, error);
          console.warn(`Failed to cleanup branch ${branchName}:`, cleanupError);
        }
      }
    }
  }

  private async pollWorkflowCompletion(runId: number) {
    const maxAttempts = 60; // 10 minutes max
    const pollInterval = 10000; // 10 seconds

    logger.info('Starting workflow polling', {
      runId,
      maxAttempts,
      pollIntervalMs: pollInterval,
      maxTimeoutMinutes: (maxAttempts * pollInterval) / 60000,
    });

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      logger.debug(`Polling attempt ${attempt + 1}/${maxAttempts}`, { runId, attempt });

      const { data: run } = await this.octokit.actions.getWorkflowRun({
        owner: this.config.owner,
        repo: this.config.repo,
        run_id: runId,
      });

      logger.debug('Workflow run status check', {
        runId,
        attempt: attempt + 1,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      });

      if (run.status === 'completed') {
        logger.info('Workflow run completed, fetching job details', {
          runId,
          conclusion: run.conclusion,
          totalAttempts: attempt + 1,
        });

        // Get jobs for detailed information
        const { data: jobs } = await this.octokit.actions.listJobsForWorkflowRun({
          owner: this.config.owner,
          repo: this.config.repo,
          run_id: runId,
        });

        logger.info('Retrieved job details', {
          runId,
          jobCount: jobs.jobs.length,
          jobStatuses: jobs.jobs.map(job => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
          })),
        });

        const result = {
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
          created_at: run.created_at,
          updated_at: run.updated_at,
          jobs: jobs.jobs.map(job => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            started_at: job.started_at,
            completed_at: job.completed_at,
            html_url: job.html_url,
          })),
        };

        logger.info('Workflow polling completed successfully', { runId, result });
        return result;
      }

      if (attempt < maxAttempts - 1) {
        logger.debug(`Workflow still running, waiting ${pollInterval}ms before next poll`, {
          runId,
          currentStatus: run.status,
          remainingAttempts: maxAttempts - attempt - 1,
        });
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    const error = new Error(`Workflow run ${runId} did not complete within the timeout period`);
    logger.error('Workflow polling timeout', error, {
      runId,
      maxAttempts,
      timeoutMinutes: (maxAttempts * pollInterval) / 60000,
    });
    throw error;
  }

  async run() {
    logger.info('Starting MCP server transport connection');
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP server connected and ready to accept requests');
  }
}

// Main execution
async function main() {
  logger.info('=== GitHub Actions Workflow MCP Server Starting ===');

  const config = {
    owner: process.env.GITHUB_OWNER || '',
    repo: process.env.GITHUB_REPO || '',
    token: process.env.GITHUB_TOKEN || '',
  };

  logger.debug('Reading configuration from environment variables', {
    hasOwner: !!config.owner,
    hasRepo: !!config.repo,
    hasToken: !!config.token,
    tokenLength: config.token.length,
  });

  try {
    ConfigSchema.parse(config);
    logger.info('Configuration validation passed');
  } catch (error) {
    logger.error(
      'Configuration validation failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        config: {
          owner: config.owner || '[missing]',
          repo: config.repo || '[missing]',
          hasToken: !!config.token,
        },
      }
    );
    console.error('Configuration error:', error);
    console.error('Please set GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN environment variables');
    process.exit(1);
  }

  try {
    const server = new GitHubActionsWorkflowServer(config);
    await server.run();
  } catch (error) {
    logger.error(
      'Failed to start server',
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    logger.error('Fatal server error', error instanceof Error ? error : new Error(String(error)));
    console.error('Server error:', error);
    process.exit(1);
  });
}
