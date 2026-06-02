import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { generateChangeDetectBuildSpec } from './codebuild/change-detect-buildspec';
import { generateChangesetCreateBuildSpec } from './codebuild/changeset-create-buildspec';
import { generateDeployBuildSpec } from './codebuild/deploy-buildspec';
import { generateRejectionCleanupBuildSpec } from './codebuild/rejection-cleanup-buildspec';

/**
 * Props for the CfnConditionalDeployPipelineStack.
 *
 * Validates: Requirements 9.1, 9.2, 9.3
 */
export interface CfnConditionalDeployPipelineStackProps extends cdk.StackProps {
  /** GitHub owner/repo string (e.g., "owner/repo") */
  readonly githubRepo: string;
  /** Branch to monitor (e.g., "main") */
  readonly githubBranch: string;
  /** ARN of the CodeStar Connection to GitHub */
  readonly connectionArn: string;
  /** Email address for SNS notifications (optional) */
  readonly notificationEmail?: string;
}

/**
 * CDK Stack that defines a CodePipeline with GitHub source integration,
 * change detection, changeset creation, manual approval, dependency-ordered
 * deployment, and SNS notifications.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 1.1, 1.2
 */
export class CfnConditionalDeployPipelineStack extends cdk.Stack {
  /** The CodePipeline construct */
  public readonly pipeline: codepipeline.Pipeline;
  /** The source artifact output from the Source stage */
  public readonly sourceArtifact: codepipeline.Artifact;
  /** The change manifest artifact output from the Change Detection stage */
  public readonly changeManifestArtifact: codepipeline.Artifact;
  /** The changeset summary artifact output from the Changeset Creation stage */
  public readonly changesetSummaryArtifact: codepipeline.Artifact;
  /** The SNS topic for approval notifications */
  public readonly approvalTopic: sns.Topic;
  /** The SNS topic for pipeline execution notifications (success/failure) */
  public readonly notificationTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: CfnConditionalDeployPipelineStackProps) {
    super(scope, id, props);

    // Source artifact produced by the Source stage
    this.sourceArtifact = new codepipeline.Artifact('SourceArtifact');

    // Change manifest artifact produced by the Change Detection stage
    this.changeManifestArtifact = new codepipeline.Artifact('ChangeManifestArtifact');

    // Changeset summary artifact produced by the Changeset Creation stage
    this.changesetSummaryArtifact = new codepipeline.Artifact('ChangesetSummaryArtifact');

    // Parse owner and repo from the githubRepo string
    const [owner, repo] = props.githubRepo.split('/');

    // Source stage action using CodeStar Connections
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub_Source',
      owner,
      repo,
      branch: props.githubBranch,
      connectionArn: props.connectionArn,
      output: this.sourceArtifact,
      triggerOnPush: true,
    });

    // --- Change Detection Stage ---
    // CodeBuild project that filters the provided changed files against the stack mapping
    // Validates: Requirements 2.1, 2.2, 2.3, 2.4
    const changeDetectProject = new codebuild.PipelineProject(this, 'ChangeDetectProject', {
      projectName: 'cfn-change-detection',
      description: 'Filters provided changed files to build change manifest',
      buildSpec: generateChangeDetectBuildSpec(),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
    });

    // Change Detection action — pass CHANGED_FILES via action env vars so pipeline variable is resolved
    const changeDetectAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Detect_Changes',
      project: changeDetectProject,
      input: this.sourceArtifact,
      outputs: [this.changeManifestArtifact],
      environmentVariables: {
        CHANGED_FILES: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: '#{variables.CHANGED_FILES}',
        },
      },
    });

    // --- Changeset Creation Stage ---
    // CodeBuild project that creates CloudFormation change sets for affected stacks
    // Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 3.3
    const changesetCreateProject = new codebuild.PipelineProject(this, 'ChangesetCreateProject', {
      projectName: 'cfn-changeset-creation',
      description: 'Creates CloudFormation change sets for stacks with changed templates',
      buildSpec: generateChangesetCreateBuildSpec(),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
    });

    // Grant CloudFormation permissions for change set creation
    changesetCreateProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:CreateChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:DescribeStacks',
          'cloudformation:GetTemplate',
        ],
        resources: ['*'],
      }),
    );

    // Grant SSM permissions for resolving dynamic references in templates
    changesetCreateProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameters',
          'ssm:GetParameter',
        ],
        resources: ['*'],
      }),
    );

    // Changeset Creation action
    const changesetCreateAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Create_Changesets',
      project: changesetCreateProject,
      input: this.sourceArtifact,
      extraInputs: [this.changeManifestArtifact],
      outputs: [this.changesetSummaryArtifact],
    });

    // --- Manual Approval Stage ---
    // SNS topic for approval notifications
    // Validates: Requirements 5.1, 5.2
    this.approvalTopic = new sns.Topic(this, 'ApprovalTopic', {
      topicName: 'cfn-deploy-approval-notifications',
      displayName: 'CFN Conditional Deploy Pipeline - Approval Notifications',
    });

    // Add email subscription if notificationEmail is provided
    if (props.notificationEmail) {
      this.approvalTopic.addSubscription(
        new sns_subscriptions.EmailSubscription(props.notificationEmail),
      );
    }

    // Manual Approval action
    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Review_Changesets',
      notificationTopic: this.approvalTopic,
      additionalInformation: 'Review the CloudFormation change sets created in the previous stage. Check the changeset summary for details on planned resource changes before approving deployment.',
    });

    // --- Deployment Stage ---
    // CodeBuild project that executes approved change sets in dependency order
    // Validates: Requirements 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 7.4
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: 'cfn-deploy-changesets',
      description: 'Executes approved CloudFormation change sets in dependency order',
      buildSpec: generateDeployBuildSpec(),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
    });

    // Grant CloudFormation permissions for change set execution and stack monitoring
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:GetTemplate',
          'cloudformation:DeleteChangeSet',
        ],
        resources: ['*'],
      }),
    );

    // Grant broad permissions needed for CloudFormation to manage stack resources
    // CloudFormation needs to be able to create/update/delete resources in the stacks
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:PassRole',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'cloudformation.amazonaws.com',
          },
        },
      }),
    );

    // Deployment action
    const deployAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Execute_Changesets',
      project: deployProject,
      input: this.sourceArtifact,
      extraInputs: [this.changesetSummaryArtifact],
    });

    // Create the pipeline (V2 type to support pipeline-level variables)
    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'cfn-conditional-deploy-pipeline',
      pipelineType: codepipeline.PipelineType.V2,
      restartExecutionOnUpdate: true,
      variables: [
        new codepipeline.Variable({
          variableName: 'CHANGED_FILES',
          description: 'Comma-separated list of changed file paths, or "ALL" to deploy all stacks',
          defaultValue: 'ALL',
        }),
      ],
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'ChangeDetection',
          actions: [changeDetectAction],
        },
        {
          stageName: 'ChangesetCreation',
          actions: [changesetCreateAction],
        },
        {
          stageName: 'ManualApproval',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'Deployment',
          actions: [deployAction],
        },
      ],
    });

    // --- Pipeline Notifications (SNS + EventBridge) ---
    // Validates: Requirements 8.1, 8.2, 8.3
    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: 'cfn-deploy-pipeline-notifications',
      displayName: 'CFN Conditional Deploy Pipeline - Execution Notifications',
    });

    // Add email subscription to the notification topic if notificationEmail is provided
    if (props.notificationEmail) {
      this.notificationTopic.addSubscription(
        new sns_subscriptions.EmailSubscription(props.notificationEmail),
      );
    }

    // EventBridge rule that matches pipeline state changes (SUCCEEDED, FAILED)
    const pipelineNotificationRule = new events.Rule(this, 'PipelineNotificationRule', {
      ruleName: 'cfn-deploy-pipeline-state-change',
      description: 'Triggers SNS notification when the pipeline execution succeeds or fails',
      eventPattern: {
        source: ['aws.codepipeline'],
        detailType: ['CodePipeline Pipeline Execution State Change'],
        detail: {
          pipeline: ['cfn-conditional-deploy-pipeline'],
          state: ['SUCCEEDED', 'FAILED'],
        },
      },
    });

    // Target the notification SNS topic with an input transformer
    // to include pipeline name, state, and execution details
    pipelineNotificationRule.addTarget(
      new events_targets.SnsTopic(this.notificationTopic, {
        message: events.RuleTargetInput.fromObject({
          pipeline: events.EventField.fromPath('$.detail.pipeline'),
          state: events.EventField.fromPath('$.detail.state'),
          executionId: events.EventField.fromPath('$.detail.execution-id'),
          region: events.EventField.fromPath('$.region'),
          account: events.EventField.fromPath('$.account'),
          time: events.EventField.fromPath('$.time'),
        }),
      }),
    );

    // --- Rejection Cleanup (EventBridge + CodeBuild) ---
    // Validates: Requirements 5.3, 5.4
    // When the ManualApproval action is rejected, trigger a CodeBuild project
    // that deletes all pending change sets.

    const rejectionCleanupProject = new codebuild.Project(this, 'RejectionCleanupProject', {
      projectName: 'cfn-rejection-cleanup',
      description: 'Deletes pending change sets when manual approval is rejected or times out',
      buildSpec: generateRejectionCleanupBuildSpec(),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        ARTIFACT_BUCKET_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.pipeline.artifactBucket.bucketName,
        },
      },
    });

    // Grant the cleanup project permissions to read from the artifact bucket
    this.pipeline.artifactBucket.grantRead(rejectionCleanupProject);

    // Grant CloudFormation permissions to delete change sets
    rejectionCleanupProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:DeleteChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:DescribeStacks',
        ],
        resources: ['*'],
      }),
    );

    // EventBridge rule that detects when the ManualApproval action is rejected/abandoned
    const rejectionCleanupRule = new events.Rule(this, 'RejectionCleanupRule', {
      ruleName: 'cfn-deploy-approval-rejection-cleanup',
      description: 'Triggers changeset cleanup when manual approval is rejected or times out',
      eventPattern: {
        source: ['aws.codepipeline'],
        detailType: ['CodePipeline Action Execution State Change'],
        detail: {
          pipeline: ['cfn-conditional-deploy-pipeline'],
          stage: ['ManualApproval'],
          action: ['Review_Changesets'],
          state: ['FAILED', 'ABANDONED'],
        },
      },
    });

    // Target the rejection cleanup CodeBuild project
    // Pass the artifact bucket and pipeline execution ID as environment variable overrides
    rejectionCleanupRule.addTarget(
      new events_targets.CodeBuildProject(rejectionCleanupProject, {
        event: events.RuleTargetInput.fromObject({
          environmentVariablesOverride: [
            {
              name: 'PIPELINE_EXECUTION_ID',
              value: events.EventField.fromPath('$.detail.execution-id'),
              type: 'PLAINTEXT',
            },
            {
              name: 'ARTIFACT_OBJECT_KEY',
              value: events.EventField.fromPath('$.detail.input-artifacts[0].s3Location.objectKey'),
              type: 'PLAINTEXT',
            },
          ],
        }),
      }),
    );
  }
}
