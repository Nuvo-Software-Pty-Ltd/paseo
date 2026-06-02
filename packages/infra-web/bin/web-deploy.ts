#!/usr/bin/env node
import "source-map-support/register";
import * as path from "node:path";
import { App, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import { StaticSpaSite } from "../lib/static-spa-site";

interface WebSpaStackProps extends StackProps {
  sourcePath: string;
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificateArn?: string;
  priceClass?: cloudfront.PriceClass;
}

class WebSpaStack extends Stack {
  constructor(scope: Construct, id: string, props: WebSpaStackProps) {
    super(scope, id, props);

    const hostedZone =
      props.hostedZoneId && props.hostedZoneName
        ? route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.hostedZoneName,
          })
        : undefined;

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Cert", props.certificateArn)
      : undefined;

    new StaticSpaSite(this, "Site", {
      sourcePath: props.sourcePath,
      domainName: props.domainName,
      hostedZone,
      certificate,
      priceClass: props.priceClass,
    });
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const account = requireEnv("CDK_DEPLOY_ACCOUNT");
const requestedRegion = requireEnv("CDK_DEPLOY_REGION");
const domainName = process.env.WEB_DOMAIN;

// CloudFront requires its cert in us-east-1. When WEB_DOMAIN is set and we'd auto-create the
// cert, the stack must deploy to us-east-1. Operators who need a non-us-east-1 region can
// pass WEB_CERT_ARN pointing at a pre-created us-east-1 cert to opt out.
if (domainName && !process.env.WEB_CERT_ARN && requestedRegion !== "us-east-1") {
  throw new Error(
    `WEB_DOMAIN is set but CDK_DEPLOY_REGION="${requestedRegion}". When a domain is supplied without WEB_CERT_ARN, the stack must deploy to us-east-1 so the auto-created ACM cert is in the CloudFront-required region. Set CDK_DEPLOY_REGION=us-east-1, or supply WEB_CERT_ARN pointing at a pre-existing us-east-1 cert.`,
  );
}
const region = requestedRegion;

const sourcePath = process.env.SPA_DIST_PATH
  ? path.resolve(process.env.SPA_DIST_PATH)
  : path.resolve(__dirname, "../../app/dist");

const stackName = process.env.WEB_STACK_NAME ?? "PaseoWebSpa";

function parsePriceClass(value: string | undefined): cloudfront.PriceClass {
  switch (value) {
    case "PRICE_CLASS_100":
      return cloudfront.PriceClass.PRICE_CLASS_100;
    case "PRICE_CLASS_200":
      return cloudfront.PriceClass.PRICE_CLASS_200;
    default:
      return cloudfront.PriceClass.PRICE_CLASS_ALL;
  }
}

const priceClass = parsePriceClass(process.env.WEB_PRICE_CLASS);

const app = new App();
new WebSpaStack(app, stackName, {
  env: { account, region },
  sourcePath,
  domainName,
  hostedZoneId: process.env.HOSTED_ZONE_ID,
  hostedZoneName: process.env.HOSTED_ZONE_NAME,
  certificateArn: process.env.WEB_CERT_ARN,
  priceClass,
});
