import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      BUCKET: "test-bucket",
      WORKER_FUNCTION_NAME: "autoace-worker",
      AUTH_MODE: "dev",
      DEV_USER_ID: "dev-user",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "testing",
      AWS_SECRET_ACCESS_KEY: "testing",
    },
  },
});
