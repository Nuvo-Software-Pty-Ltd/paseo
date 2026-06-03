// TODO(security-headers): CSP, HSTS, Permissions-Policy via a CloudFront response-headers
// policy are deferred per design-doc § "Out of scope". Wire here when designed.
//
// Cache-Control IS wired, via the two ResponseHeadersPolicy resources created in the
// constructor: no-cache for index.html (default behavior), 1yr-immutable for the
// content-hashed `_expo/*` and `assets/*` behaviors.
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3Deployment from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface StaticSpaSiteProps {
  /** Local path to the `dist/` directory from `npm run build:web --workspace=@getpaseo/app`. */
  sourcePath: string;
  /** e.g. "app.orchestra.nuvo.software". Optional; if absent, only the `dxyz.cloudfront.net` URL is reachable. */
  domainName?: string;
  /** Route53 zone for the A alias. Optional. If `domainName` is set but this is not, no record is created. */
  hostedZone?: route53.IHostedZone;
  /** ACM cert in us-east-1. Optional; created automatically when `hostedZone` is provided and this is absent. */
  certificate?: acm.ICertificate;
  /** Default `PriceClass_All`. Orchestra sets `PriceClass_100`. */
  priceClass?: cloudfront.PriceClass;
}

export class StaticSpaSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly distributionId: string;
  readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: StaticSpaSiteProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // bin/web-deploy.ts enforces CDK_DEPLOY_REGION=us-east-1 whenever WEB_DOMAIN is set
    // without WEB_CERT_ARN, so the auto-created cert lands in the CloudFront-required region.
    let certificate = props.certificate;
    if (!certificate && props.hostedZone && props.domainName) {
      certificate = new acm.Certificate(this, "Certificate", {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(props.hostedZone),
      });
    }
    if (props.domainName && !certificate) {
      throw new Error(
        "StaticSpaSite: when `domainName` is set without `hostedZone`, `certificate` must be supplied explicitly (DNS validation needs the zone).",
      );
    }

    // Cache-Control response headers. S3 origins emit no Cache-Control by default and
    // CloudFront passes that through, so browsers get no caching guidance. These policies
    // make CloudFront stamp Cache-Control on the viewer response:
    //   - index.html (default behavior): always revalidate, never serve stale HTML.
    //   - _expo/* and assets/*: content-hashed by `expo export`, so cache for a year and
    //     mark immutable — a content change ships a new filename, never a stale hit.
    const htmlHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "HtmlHeadersPolicy", {
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "cache-control",
            value: "public, max-age=0, must-revalidate",
            override: true,
          },
        ],
      },
    });
    const immutableHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "ImmutableHeadersPolicy",
      {
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "cache-control",
              value: "public, max-age=31536000, immutable",
              override: true,
            },
          ],
        },
      },
    );

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: htmlHeadersPolicy,
        compress: true,
      },
      additionalBehaviors: {
        "_expo/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: immutableHeadersPolicy,
          compress: true,
        },
        "assets/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: immutableHeadersPolicy,
          compress: true,
        },
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.seconds(0),
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_ALL,
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      enableLogging: false,
    });

    // Only index.html needs CloudFront invalidation on each deploy — Expo content-hashes
    // every other asset, so stale objects expire naturally. prune:true cleans orphans.
    new s3Deployment.BucketDeployment(this, "Deployment", {
      sources: [s3Deployment.Source.asset(props.sourcePath)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/index.html"],
      prune: true,
    });

    if (props.hostedZone && props.domainName) {
      new route53.ARecord(this, "AliasRecord", {
        zone: props.hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.distribution),
        ),
      });
    }

    this.distributionId = this.distribution.distributionId;
    this.distributionDomainName = this.distribution.distributionDomainName;
  }
}
