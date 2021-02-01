import { App, Construct, Stack, Tags} from "@aws-cdk/core";
import { SecurityGroup, Peer, Port, IVpc } from "@aws-cdk/aws-ec2";
import { tag, rules_map } from './../common/gateu-props';

export function applyTags(
  scope:  App | Construct,
  tags:   tag[]) {
    if (tags != null) {      
      for (let tag of tags) {
        Tags.of (scope).add(tag.key, tag.value);
      }
    }
}

export function createSecurityGroup (
  scope:  App | Construct| Stack,
  vpc:    IVpc,
  name:   string,
  description: string,
  ingressRules?:  rules_map[]
) : SecurityGroup {
  
  const securityGroup = new SecurityGroup(scope, name, {
        vpc:  vpc,
        securityGroupName: name,
        description: description,
  });

  if (ingressRules != null) {
    for (let ingressRule of ingressRules) {
      securityGroup.addIngressRule(Peer.ipv4(ingressRule.in), Port.tcp(ingressRule.out), ingressRule.desc)
    }
  }
  return securityGroup;
}
