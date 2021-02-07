import { Construct, CfnOutput, Duration, RemovalPolicy, SecretValue } from '@aws-cdk/core';
import { IRepository, Repository } from '@aws-cdk/aws-ecr';
import { AwsLogDriver, Cluster, ContainerDefinition, ContainerImage, FargateTaskDefinition } from "@aws-cdk/aws-ecs";
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { ApplicationLoadBalancedFargateService } from "@aws-cdk/aws-ecs-patterns";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "@aws-cdk/aws-iam";
import { BuildSpec, LinuxBuildImage, PipelineProject} from '@aws-cdk/aws-codebuild';
import { Artifact, Pipeline } from '@aws-cdk/aws-codepipeline';
import { CodeBuildAction, EcsDeployAction, GitHubSourceAction, ManualApprovalAction } from '@aws-cdk/aws-codepipeline-actions';
import { GateUParentStack, GateUParentStackProps } from "./common/gateu-parent-stack";
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import { join } from 'path';
import { BlockPublicAccess, Bucket, BucketEncryption} from '@aws-cdk/aws-s3';
import { pipeline_s3, containers } from '../config/common.json';

export interface EcsCdkStackProps extends GateUParentStackProps {
}
export class EcsCdkStack extends GateUParentStack {
  constructor(scope: Construct, id: string, props: EcsCdkStackProps) {
    super(scope, id, props);

    const cluster = new Cluster(this, this.getNameFor('fargate-cluster'), {
      vpc: this.vpc,
    });

    let lg = new LogGroup(this, this.getNameFor('lg'), {
      logGroupName: `/ecs/${this.getNameFor('lg')}`,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.TWO_WEEKS
    });
    
    const logging = new AwsLogDriver({
      streamPrefix: "ecs-logs",
      logGroup: lg
    });

    const taskRole = new Role(this, this.getNameFor('ecs-taskRole'), {
      roleName: this.getNameFor('ecs-taskRole'),
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    // ***ECS Contructs***
    const executionRolePolicy =  new PolicyStatement({
      effect: Effect.ALLOW,
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

    const taskDef = new FargateTaskDefinition(this, this.getNameFor('ecs-taskdef'), {
      family: this.getNameFor('ecs-taskdef'),
      taskRole: taskRole
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    let asset: DockerImageAsset;
    let container: ContainerDefinition;

    for (let cont of containers) {  
      asset = new DockerImageAsset(this, this.getNameFor(cont.name +'-asset'), {
        directory: join(__dirname, '../../', cont.name)
      });
      container = taskDef.addContainer(cont.name, {
        image: ContainerImage.fromEcrRepository(asset.repository, asset.imageUri.split(":").pop()),
        memoryLimitMiB: 256,
        cpu: 256,
        logging
      });
      container.addPortMappings({containerPort: cont.port});
    }

    const fargateService = new ApplicationLoadBalancedFargateService(this, this.getNameFor('ecs-service'), {
      serviceName: this.getNameFor('ecs-service'),
      cluster: cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: false
    });

    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 2 });
    scaling.scaleOnCpuUtilization(this.getNameFor('cpu-scaling'), {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(300)
    });

    const ecrRepoMap: Map<string, IRepository> = new Map();
    let aRepo: IRepository;

    for (let cont of containers) {  
      aRepo = new Repository(this, this.getNameFor(cont.name), {
        repositoryName: cont.repo,
        removalPolicy: RemovalPolicy.DESTROY,
        imageScanOnPush: true,
        lifecycleRules: [{ maxImageCount: 3 }]
      });
      ecrRepoMap.set(cont.name, aRepo);
    }

    // ***PIPELINE CONSTRUCTS***
      //create atrifacts s3 bucket for pipeline
    const artifactBucket = new Bucket(this, this.getNameFor(pipeline_s3), {
        bucketName: this.getNameFor(pipeline_s3),
        encryption: BucketEncryption.KMS_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL
    });

    const sourceOutput = new Artifact(this.getNameFor('source-output'));
    const buildOutput = new Artifact(this.getNameFor('build-output'));

    const buildProject = new PipelineProject(
      this, this.getNameFor('build-project'), {
        projectName: this.getNameFor('build-project'),
        environment: {
          buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
          privileged: true,
        },
        buildSpec: BuildSpec.fromSourceFilename('./buildspec.yml'),
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

      buildProject.addToRolePolicy(new PolicyStatement({
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
    const sourceAction = new GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'nrahi',
      repo: 'amazon-ecs-fargate-cdk-cicd',
      branch: 'main',
      oauthToken: SecretValue.secretsManager("/nirmal/github/token"),
      output: sourceOutput,
      variablesNamespace: this.getNameFor('github-source')
    });

    const buildAction = new CodeBuildAction({
      actionName: 'CodeBuild',
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput]
    });

    const manualApprovalAction = new ManualApprovalAction({
      actionName: 'Approve'
    });

    const deployAction = new EcsDeployAction({
      actionName: 'DeployAction',
      service: fargateService.service,
      input: buildOutput
    });

    // PIPELINE STAGES
    new Pipeline(this, this.getNameFor('pipeline'), {
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
    new CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });
  }
}