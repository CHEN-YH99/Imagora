import { spawn } from "node:child_process";

const args = ["compose", "-f", "infra/docker-compose.prod.yml", "up", "-d", "--build"];
const child = spawn("docker", args, {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
