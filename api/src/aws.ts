import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";

import { config } from "./config";

export const s3 = new S3Client({ region: config.AWS_REGION });
export const lambda = new LambdaClient({ region: config.AWS_REGION });
