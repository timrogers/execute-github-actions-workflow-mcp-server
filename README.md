# GitHub Actions Workflow Executor MCP Server

An MCP (Model Context Protocol) server that allows you to execute GitHub Actions workflows programmatically by pushing them to a temporary branch and monitoring their execution.

## Features

- **YAML Validation**: Validates GitHub Actions workflows using `action-validator` before execution
- **Automatic Trigger Mutation**: Converts any workflow trigger to `push` to ensure execution
- **Re-validation**: Validates the mutated workflow before execution
- Execute GitHub Actions workflows from YAML content or file paths
- **Comprehensive Logging**: Extensive logging to both `stderr` and `log/mcp.log` file
- **Robust Cleanup**: Guaranteed branch cleanup even on errors using finally blocks
- Automatic branch creation and cleanup
- Real-time workflow monitoring and polling
- Detailed execution results including job status and logs
- Environment variable configuration for GitHub credentials

## Installation

```bash
npm install
```

No build step required - the server runs TypeScript directly using `tsx`.

## Configuration

Set the following environment variables:

- `GITHUB_OWNER`: The GitHub repository owner/organization
- `GITHUB_REPO`: The repository name
- `GITHUB_TOKEN`: A GitHub personal access token with appropriate permissions

### Required GitHub Token Permissions

Your GitHub token needs the following permissions:

- `repo` (Full control of private repositories)
- `actions` (Read and write access to GitHub Actions)

## Usage

### Starting the Server

```bash
export GITHUB_OWNER="your-username"
export GITHUB_REPO="your-repo-name"
export GITHUB_TOKEN="your-github-token"
npm start
```

Or run directly with tsx:

```bash
GITHUB_OWNER="your-username" GITHUB_REPO="your-repo-name" GITHUB_TOKEN="your-github-token" npx tsx src/index.ts
```

### Tool: execute_github_actions_workflow

Execute a GitHub Actions workflow with the following parameters:

- `workflow_yaml` (optional): The YAML content of the workflow file
- `workflow_path` (optional): Path to an existing workflow file on disk
- `branch_name` (optional): Custom branch name (defaults to auto-generated timestamp)

**Note**: Either `workflow_yaml` or `workflow_path` must be provided.

### Example Workflow YAML

```yaml
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Echo test
        run: echo "Hello from MCP executed workflow!"
```

## How It Works

1. **Initial YAML Validation**: Validates the original workflow YAML using `action-validator`
2. **Trigger Mutation**: Automatically changes the workflow trigger to `push` to ensure execution
3. **Re-validation**: Validates the mutated workflow to ensure it's still valid
4. **Branch Creation**: Creates a temporary branch from the default branch
5. **Workflow Push**: Pushes the mutated workflow YAML to `.github/workflows/mcp-executed-workflow.yml`
6. **Execution Monitoring**: Polls the workflow run status every 10 seconds
7. **Result Collection**: Gathers detailed job information and results
8. **Guaranteed Cleanup**: Always deletes the temporary branch using finally blocks

## Error Handling

- **Pre-execution Validation**: Uses `action-validator` to validate workflow YAML syntax and schema
- Validates GitHub credentials and repository access
- Handles API rate limits and network errors
- Automatic cleanup on failure
- Timeout protection (10-minute maximum execution time)

## Development

```bash
# Run in development mode (same as npm start)
npm run dev

# Or run directly
npx tsx src/index.ts

# Build TypeScript (optional, for distribution)
npm run build

# Linting and formatting
npm run lint          # Run ESLint
npm run lint:fix       # Fix ESLint issues automatically
npm run format         # Format code with Prettier
npm run format:check   # Check if code is formatted
```

### Code Quality

This project uses:

- **ESLint v9** with TypeScript support for code linting
- **Prettier** for code formatting
- **GitHub Actions CI** that runs on every push and PR:
  - Linting with ESLint
  - Format checking with Prettier
  - TypeScript build verification
  - Basic server startup test
- **Dependabot** for automated dependency updates

### Logging

The server provides comprehensive logging to both stderr and `log/mcp.log`:

- **Log Levels**: DEBUG, INFO, WARN, ERROR (configurable via `LOG_LEVEL` env var)
- **Structured Logging**: All logs include timestamps, levels, and contextual data
- **Operation Tracking**: Detailed logging of GitHub API calls, workflow execution stages, and validation steps
- **Error Handling**: Full error context including stack traces when available

## Limitations

- Maximum workflow execution time: 10 minutes
- Workflows must have valid triggers (the tool pushes to a branch)
- Requires appropriate GitHub API permissions
- Limited to public repositories or repositories accessible with the provided token
