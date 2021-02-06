#!/usr/bin/env node
import 'source-map-support/register';
import { App } from '@aws-cdk/core';
import { EcsCdkStack } from '../lib/ecs_cdk-stack';
import * as int from "../config/integration.json";
import {name_tag } from '../config/common.json';

const app = new App();

new EcsCdkStack(app, name_tag.value_prefix + 'stack-int', {
  env: int.env,
  envTags: int.env_tags,
  vpcAttributes: int.vpcAttributes
});
