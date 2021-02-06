import cdk = require('@aws-cdk/core');
import ecr = require('@aws-cdk/aws-ecr');
import ecs = require("@aws-cdk/aws-ecs");
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import ecs_patterns = require("@aws-cdk/aws-ecs-patterns");
import iam = require("@aws-cdk/aws-iam");
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');
import { GateUParentStack, GateUParentStackProps } from "./common/gateu-parent-stack";
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import * as path from 'path';
import * as s3 from '@aws-cdk/aws-s3';
import { pipeline_s3, containers } from '../config/common.json';

export interface EcsCdkStackProps extends GateUParentStackProps {
}
export class EcsCdkStack extends GateUParentStack {
  constructor(scope: cdk.Construct, id: string, props: EcsCdkStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, this.getNameFor('fargate-cluster'), {
      vpc: this.vpc,
    });

    let lg = new LogGroup(this, this.getNameFor('lg'), {
      logGroupName: `/ecs/${this.getNameFor('lg')}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: RetentionDays.TWO_WEEKS
    });
    
    const logging = new ecs.AwsLogDriver({
      streamPrefix: "ecs-logs",
      logGroup: lg
    });

    const taskRole = new iam.Role(this, this.getNameFor('ecs-taskRole'), {
      roleName: this.getNameFor('ecs-taskRole'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    // ***ECS Contructs***
    const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ]
    });

    const taskDef = new ecs.FargateTaskDefinition(this, this.getNameFor('ecs-taskdef'), {
      family: this.getNameFor('ecs-taskdef'),
      taskRole: taskRole
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    let asset: DockerImageAsset;
    let container: ecs.ContainerDefinition;

    for (let cont of containers) {  
      asset = new DockerImageAsset(this, this.getNameFor(cont.name +'-asset'), {
        directory: path.join(__dirname, '../../', cont.name)
      });
      container = taskDef.addContainer(cont.name, {
        image: ecs.ContainerImage.fromEcrRepository(asset.repository, asset.imageUri.split(":").pop()),
        memoryLimitMiB: 256,
        cpu: 256,
        logging
      });
      container.addPortMappings({containerPort: cont.port});
    }

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, this.getNameFor('ecs-service'), {
      serviceName: this.getNameFor('ecs-service'),
      cluster: cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: false
    });

    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 2 });
    scaling.scaleOnCpuUtilization(this.getNameFor('cpu-scaling'), {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(300)
    });

    const ecrRepoMap: Map<string, ecr.IRepository> = new Map();
    let aRepo: ecr.IRepository;

    for (let cont of containers) {  
      aRepo = new ecr.Repository(this, this.getNameFor(cont.name), {
        repositoryName: cont.repo,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        imageScanOnPush: true,
        lifecycleRules: [{ maxImageCount: 3 }]
      });
      ecrRepoMap.set(cont.name, aRepo);
    }

    // ***PIPELINE CONSTRUCTS***
      //create atrifacts s3 bucket for pipeline
    const artifactBucket = new s3.Bucket(this, this.getNameFor(pipeline_s3), {
        bucketName: this.getNameFor(pipeline_s3),
        encryption: s3.BucketEncryption.KMS_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    });

    const sourceOutput = new codepipeline.Artifact(this.getNameFor('source-output'));
    const buildOutput = new codepipeline.Artifact(this.getNameFor('build-output'));

    const buildProject = new codebuild.PipelineProject(
      this, this.getNameFor('build-project'), {
        projectName: this.getNameFor('build-project'),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
          privileged: true,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('./buildspec.yml'),
        environmentVariables: {
          'REGION': {
            value: `${props.env?.region}`
          },
          'ACCOUNT': {
            value: `${props.env?.account}`
          },
          'CLUSTER_NAME': {
            value: `${cluster.clusterName}`
          },
          'FLASK_REPO_URI': {
            value: `${ecrRepoMap.get("flask-docker-app")?.repositoryUri}`
          }
        }
      });

      buildProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "ecs:DescribeCluster",
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
          ],
        resources: [`${cluster.clusterArn}`],
      }));

      for (var name in ecrRepoMap) {
        ecrRepoMap.get(name)?.grantPullPush(buildProject.role!)
      }
  
    // ***PIPELINE ACTIONS***
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'nrahi',
      repo: 'amazon-ecs-fargate-cdk-cicd',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager("/nirmal/github/token"),
      output: sourceOutput,
      variablesNamespace: this.getNameFor('github-source')
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput]
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve'
    });

    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'DeployAction',
      service: fargateService.service,
      input: buildOutput
    });

    // PIPELINE STAGES
    new codepipeline.Pipeline(this, this.getNameFor('pipeline'), {
      pipelineName:   this.getNameFor("pipeline"),
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Approve',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'Deploy-to-INTEGRATION',
          actions: [deployAction],
        }
      ]
    });

    //OUTPUT
    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });
  }
}
