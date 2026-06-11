# CFN Conditional Deploy Pipeline

A CDK-defined AWS CodePipeline that monitors a GitHub repository, detects which CloudFormation templates changed, validates them, creates change sets, waits for manual approval, then deploys only the affected stacks in dependency order.

## Pipeline Stages

```
Source → Change Detection → Template Validation → Changeset Creation → Manual Approval → Deployment
```

| Stage | What it does |
|-------|-------------|
| **Source** | Pulls source from GitHub via CodeStar Connection on each commit |
| **Change Detection** | Reads the `CHANGED_FILES` pipeline variable, filters to `.json` templates, resolves target accounts from SSM |
| **Template Validation** | Validates JSON syntax, CloudFormation structure, and calls `validate-template` API |
| **Changeset Creation** | Creates CloudFormation change sets for each affected stack (cross-account via `githubExecutionRole`) |
| **Manual Approval** | Sends SNS notification with account/stack/changeset details and pauses for human review |
| **Deployment** | Executes approved change sets in dependency wave order |

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Pipeline Account                                  │
│                                                                          │
│  CodePipeline ─── CodeBuild (Detect) ─── CodeBuild (Validate)           │
│       │                                                                  │
│       └── CodeBuild (Changeset) ──── Approval ──── CodeBuild (Deploy)   │
│                    │                                        │             │
│                    │  sts:AssumeRole                        │             │
│                    ▼                                        ▼             │
└────────────────────┼────────────────────────────────────────┼────────────┘
                     │                                        │
         ┌───────────▼────────────┐               ┌──────────▼─────────────┐
         │   Target Account A     │               │   Target Account B      │
         │                        │               │                         │
         │  githubExecutionRole   │               │  githubExecutionRole    │
         │  CloudFormation Stacks │               │  CloudFormation Stacks  │
         └────────────────────────┘               └─────────────────────────┘
```

## GitHub Action (Trigger Workflow)

The pipeline is triggered by a GitHub Action in the **source repository** (e.g., `cfnsamples`). On each push to `main`, the action detects which files changed and passes them to the AWS CodePipeline as a variable.

### Workflow File (`.github/workflows/blank.yml`)

```yaml
name: Deploy Cfn Stacks

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]
  workflow_dispatch:

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # Required for OIDC authentication
      contents: read    # Required to check out the repository

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<PIPELINE_ACCOUNT_ID>:role/githubRole
          aws-region: us-west-2

      - run: |
          echo "Triggering AWS Pipeline"
          if [[ ${{ github.event_name }} == 'pull_request' ]]; then
            changed_files=$(git diff --name-only -r HEAD^1 HEAD | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
          else
            changed_files=$(git diff --name-only ${{ github.event.before }} ${{ github.event.after }} | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
          fi
          echo "Changed files: $changed_files"
          if [ -z "$changed_files" ]; then
            echo "No changed files detected. Skipping pipeline trigger."
            exit 0
          fi
          aws codepipeline start-pipeline-execution \
            --name cfn-conditional-deploy-pipeline \
            --variables "[{\"name\":\"CHANGED_FILES\",\"value\":\"$changed_files\"}]"
```

### How It Works

1. **Checkout** — fetches the full git history (`fetch-depth: 0`) so `git diff` can compare commits
2. **OIDC Auth** — uses GitHub's OIDC token to assume `githubRole` in the pipeline account (no long-lived credentials)
3. **Detect changes** — runs `git diff` between the previous and current commit, filters empty lines, and joins paths with commas
4. **Trigger pipeline** — calls `aws codepipeline start-pipeline-execution` with the changed file list as the `CHANGED_FILES` pipeline variable (uses JSON syntax to avoid comma-parsing issues with AWS CLI shorthand)

The pipeline then uses this variable in the Change Detection stage to determine which templates to process.

> **Note:** The `--variables` parameter uses JSON array syntax (`[{"name":"...","value":"..."}]`) instead of shorthand (`name=X,value=Y`) because the shorthand interprets commas in the value as field delimiters.

### GitHub OIDC IAM Role (`githubRole`)

This role lives in the **pipeline account** and allows GitHub Actions to authenticate via OIDC (no access keys needed).

**Create the OIDC identity provider** (one-time per account):


**Create the `githubRole`** with trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<PIPELINE_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<GITHUB_ORG>/<REPO_NAME>:*"
        }
      }
    }
  ]
}
```

**Permissions needed by `githubRole`:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "codepipeline:StartPipelineExecution",
      "Resource": "arn:aws:codepipeline:us-west-2:<PIPELINE_ACCOUNT_ID>:cfn-conditional-deploy-pipeline"
    }
  ]
}
```

Replace `<PIPELINE_ACCOUNT_ID>` with your pipeline account ID and `<GITHUB_ORG>/<REPO_NAME>` with your repository (e.g., `tfcsamples/cfnsamples`).

> **Security:** The OIDC condition restricts the role to only be assumed by workflows running in your specific repository. No long-lived AWS credentials are stored in GitHub.

---

## Prerequisites

### 1. AWS CodeStar Connection to GitHub

Create a CodeStar Connection in the pipeline account:

```bash
aws codeconnections create-connection \
  --provider-type GitHub \
  --connection-name my-github-connection \
  --region us-west-2
```

Then complete the handshake in the AWS Console (Developer Tools → Connections → select the connection → "Update pending connection").

Note the Connection ARN — you'll need it for deployment.

### 2. SSM Parameters for Account Mapping

The pipeline resolves target AWS account IDs from SSM Parameter Store based on the folder name of each template. For each folder in your repository that contains CloudFormation templates, create an SSM parameter:

```bash
# Pattern: /cfn-deploy/accounts/{folder-name}
aws ssm put-parameter \
  --name "/cfn-deploy/accounts/dev" \
  --type "String" \
  --value "123456789012" \
  --region us-west-2

aws ssm put-parameter \
  --name "/cfn-deploy/accounts/prod" \
  --type "String" \
  --value "987654321098" \
  --region us-west-2
```

The value must be a 12-digit AWS account ID.

### 3. Cross-Account IAM Role (`githubExecutionRole`)

Each target account needs a `githubExecutionRole` that the pipeline can assume. Deploy the provided CloudFormation template in each target account:

```bash
aws cloudformation deploy \
  --template-file cfn/github-execution-role.json \
  --stack-name github-execution-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides PipelineAccountId=<YOUR_PIPELINE_ACCOUNT_ID> \
  --region us-west-2
```

**What this role provides:**

| Permission | Purpose |
|-----------|---------|
| `cloudformation:CreateChangeSet` | Create change sets for stacks |
| `cloudformation:ExecuteChangeSet` | Deploy approved change sets |
| `cloudformation:DescribeStacks` | Monitor stack status |
| `cloudformation:DeleteChangeSet` | Cleanup on rejection |
| `ec2:*` | Manage EC2 resources in deployed stacks |
| `iam:PassRole` | Allow CloudFormation to assume service roles |
| `ssm:GetParameter` | Resolve dynamic references in templates |

**Trust policy:** The role trusts the pipeline account with a condition restricting to CDK-created roles matching `CfnConditionalDeployPipel-*`.

> **Important:** Adjust the permissions in the `CloudFormationDeployPolicy` to match what your templates actually create. The example grants `ec2:*` — scope this down to what your stacks need.

### 4. Repository Structure

Your GitHub repository should contain CloudFormation templates organized in folders. Each folder maps to a target account:

```
├── dev/
│   ├── vpc.json          → deploys to dev account as stack "dev-vpc"
│   └── ec2.json          → deploys to dev account as stack "dev-ec2"
├── prod/
│   ├── vpc.json          → deploys to prod account as stack "prod-vpc"
│   └── ec2.json          → deploys to prod account as stack "prod-ec2"
└── shared/
    └── iam.json          → deploys to shared account as stack "shared-iam"
```

**Naming convention:** Stack names are derived as `{folder}-{filename_without_extension}`.

## Deployment

### Install Dependencies

```bash
npm install
```

### Configure

Update `cdk.json` with your own GitHub repository and CodeStar Connection ARN:

```json
{
  "context": {
    "githubRepo": "your-org/your-repo",
    "connectionArn": "arn:aws:codeconnections:us-west-2:YOUR_ACCOUNT_ID:connection/YOUR_CONNECTION_ID"
  }
}
```

You can also set these values via CLI context or environment variables at deploy time:

| Parameter | Required | Description | Default |
|-----------|----------|-------------|---------|
| `githubRepo` | Yes | GitHub `owner/repo` string | — |
| `githubBranch` | No | Branch to monitor | `main` |
| `connectionArn` | Yes | CodeStar Connection ARN | — |
| `notificationEmail` | No | Email for SNS notifications | — |
| `stackMappingPath` | No | Path to stack-mapping.json in the repo | `stack-mapping.json` |

### Deploy the Pipeline

**Option A: Using CDK (recommended)**

```bash
# Using cdk.json context (already configured)
npx cdk deploy

# Or override via CLI
npx cdk deploy \
  --context githubRepo=myorg/myrepo \
  --context connectionArn=arn:aws:codeconnections:us-west-2:111111111111:connection/abc-123 \
  --context notificationEmail=team@example.com
```

**Option B: Using CloudFormation directly (no CDK)**

A pre-generated CloudFormation template is available at `cfn/pipeline-stack.yaml`. Replace the placeholder values and deploy:

```bash
# 1. Replace placeholders in cfn/pipeline-stack.yaml:
#    - CONNECTION_ARN_PLACEHOLDER  → your CodeStar Connection ARN
#    - REPO_ID_PLACEHOLDER        → your GitHub owner/repo (e.g., myorg/myrepo)
#    - BRANCH_PLACEHOLDER         → your branch name (e.g., main)

sed -i 's|CONNECTION_ARN_PLACEHOLDER|arn:aws:codeconnections:us-west-2:111111111111:connection/abc-123|g' cfn/pipeline-stack.yaml
sed -i 's|REPO_ID_PLACEHOLDER|myorg/myrepo|g' cfn/pipeline-stack.yaml
sed -i 's|BRANCH_PLACEHOLDER|main|g' cfn/pipeline-stack.yaml

# 2. Deploy:
aws cloudformation deploy \
  --template-file cfn/pipeline-stack.yaml \
  --stack-name CfnConditionalDeployPipelineStack \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --region us-west-2
```

To regenerate the template after making CDK code changes:

```bash
npm install
npx cdk synth --no-staging > cfn/pipeline-stack.yaml
```

### Bootstrap (if needed)

If this is the first CDK deployment in the account/region:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

## Usage

### Triggering Deployments

The pipeline uses a V2 pipeline with a `CHANGED_FILES` variable. When triggering manually from the console, provide a comma-separated list of template paths:

```
dev/ec2.json,dev/vpc.json
```

Or set to `ALL` to deploy all stacks (though the current implementation requires explicit paths).

### Template Validation

Before changeset creation, templates are validated in three layers:

1. **File existence** — template must exist in the source artifact
2. **JSON syntax** — must be valid JSON
3. **CloudFormation structure** — must have a `Resources` key, no invalid top-level keys
4. **CloudFormation API** — `validate-template` API call for semantic validation

If any template fails, the pipeline halts and reports all errors in `validation-report.json`.

### Manual Approval

After change sets are created, the pipeline pauses and sends an SNS notification. The approval popup in the CodePipeline console shows which accounts and stacks have pending change sets:

```
Pending change sets: Account: 123456789012 | Stack: dev-ec2 | ChangeSet: pipeline-cs-abc12345-dev-ec2; Account: 987654321098 | Stack: prod-ec2 | ChangeSet: pipeline-cs-abc12345-prod-ec2
```

This lets you jump straight to the correct account and stack in the CloudFormation console to inspect each change set before approving.

Review the change sets in the CloudFormation console, then approve or reject in the CodePipeline console.

On rejection:
- An EventBridge rule triggers a cleanup CodeBuild project
- All pending change sets are deleted

### Deployment Order

If templates have dependencies (defined in `stack-mapping.json` via `dependsOn`), they deploy in topological wave order. Independent stacks deploy in parallel within a wave.

## Project Structure

```
├── bin/
│   └── app.ts                              # CDK app entry point
├── cfn/
│   ├── github-execution-role.json          # Cross-account role template (deploy in each target account)
│   └── pipeline-stack.yaml                 # Generated pipeline CloudFormation template (for non-CDK users)
├── lib/
│   ├── cfn-conditional-deploy-pipeline-stack.ts  # Main CDK stack
│   ├── template-validator.ts               # Pure validation module
│   ├── change-detector.ts                  # Change detection logic
│   ├── changeset-creator.ts                # Changeset selection logic
│   ├── dependency-graph.ts                 # Topological sort & failure propagation
│   ├── models.ts                           # TypeScript interfaces
│   ├── notification.ts                     # Notification formatting
│   ├── stack-mapping.ts                    # Stack mapping parser
│   └── codebuild/
│       ├── change-detect-buildspec.ts      # Change detection buildspec
│       ├── template-validate-buildspec.ts  # Template validation buildspec
│       ├── changeset-create-buildspec.ts   # Changeset creation buildspec
│       ├── deploy-buildspec.ts             # Deployment buildspec
│       └── rejection-cleanup-buildspec.ts  # Approval rejection cleanup
├── test/
│   ├── properties/                         # Property-based tests (fast-check)
│   └── *.test.ts                           # Unit tests
├── cdk.json                                # CDK configuration
├── package.json
└── tsconfig.json
```

## IAM Permissions Summary

### Pipeline Account (created by CDK)

| CodeBuild Project | Key Permissions |
|------------------|----------------|
| `cfn-change-detection` | `ssm:GetParameter`, `sts:GetCallerIdentity` |
| `cfn-template-validation` | `cloudformation:ValidateTemplate` |
| `cfn-changeset-creation` | `cloudformation:CreateChangeSet`, `sts:AssumeRole` (to `githubExecutionRole`) |
| `cfn-deploy-changesets` | `cloudformation:ExecuteChangeSet`, `sts:AssumeRole` (to `githubExecutionRole`), `iam:PassRole` |
| `cfn-rejection-cleanup` | `cloudformation:DeleteChangeSet`, `sts:AssumeRole`, S3 artifact read |

### Target Accounts (`githubExecutionRole`)

| Permission | Why |
|-----------|-----|
| CloudFormation full change set lifecycle | Create, describe, execute, delete change sets |
| EC2 (scoped to your needs) | Manage resources created by your templates |
| IAM PassRole | Allow CloudFormation to use service roles |
| SSM read | Resolve `{{resolve:ssm:...}}` dynamic references |

## Development

```bash
# Build
npm run build

# Run tests
npm test

# Watch mode (TypeScript)
npm run watch

# Synth CloudFormation template
npx cdk synth

# Diff against deployed stack
npx cdk diff
```

## Notifications

The pipeline publishes to two SNS topics:

| Topic | Events |
|-------|--------|
| `cfn-deploy-approval-notifications` | Manual approval requests |
| `cfn-deploy-pipeline-notifications` | Pipeline execution SUCCEEDED/FAILED |

Both subscribe the `notificationEmail` (if provided). You can add additional subscriptions (Slack, PagerDuty, etc.) to these topics after deployment.
