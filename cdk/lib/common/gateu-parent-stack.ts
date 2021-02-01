import { Construct, Stack, StackProps} from '@aws-cdk/core';
import { IVpc, Vpc, VpcAttributes } from '@aws-cdk/aws-ec2';
import {name_tag, global_tags } from '../../config/common.json';
import { tag } from './gateu-props';
import { applyTags } from '../functions/gateu-functions';

export interface GateUParentStackProps extends StackProps {
    readonly envTags:  tag[],
    readonly vpcAttributes: VpcAttributes
}

export class GateUParentStack extends Stack {
  protected readonly vpc: IVpc;

  protected getNameFor(resource: string): string {
    return `${name_tag.value_prefix}${resource}`;   
  }

  constructor(scope: Construct, id: string, props: GateUParentStackProps) {
    super(scope, id, props);
    
    this.vpc = Vpc.fromVpcAttributes(this, 
      this.getNameFor('VPC'), props.vpcAttributes);

    /////applying global tags to all resources in this stack
    applyTags(this, global_tags);
    applyTags(this, props.envTags);
  }
}
