// Cross-platform production entrypoint for native Node deployments.
process.env.NODE_ENV = "production";
await import("./dist/server.js");
