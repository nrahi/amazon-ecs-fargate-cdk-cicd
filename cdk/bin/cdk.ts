#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { EcsCdkStack } from '../lib/ecs_cdk-stack';
import * as int from "../config/integration.json";

const app = new cdk.App();

new EcsCdkStack(app, 'EcsCdkStack-INT', {
  env: int.env,
  envTags: int.env_tags,
  vpcAttributes: int.vpcAttributes
});
