#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CfnConditionalDeployPipelineStack } from '../lib/cfn-conditional-deploy-pipeline-stack';

const app = new cdk.App();

// Read configuration from CDK context or environment variables
// CDK context values can be set via cdk.json, --context flag, or environment variables
const githubRepo = app.node.tryGetContext('githubRepo')
  ?? process.env.GITHUB_REPO;
const githubBranch = app.node.tryGetContext('githubBranch')
  ?? process.env.GITHUB_BRANCH
  ?? 'main';
const connectionArn = app.node.tryGetContext('connectionArn')
  ?? process.env.CONNECTION_ARN;
const notificationEmail = app.node.tryGetContext('notificationEmail')
  ?? process.env.NOTIFICATION_EMAIL;

// Validate required configuration
if (!githubRepo) {
  throw new Error('Missing required configuration: githubRepo (set via CDK context or GITHUB_REPO env var)');
}
if (!connectionArn) {
  throw new Error('Missing required configuration: connectionArn (set via CDK context or CONNECTION_ARN env var)');
}

new CfnConditionalDeployPipelineStack(app, 'CfnConditionalDeployPipelineStack', {
  githubRepo,
  githubBranch,
  connectionArn,
  notificationEmail,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
