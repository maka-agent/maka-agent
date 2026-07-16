import os
import shlex

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class OpenCodeTitleAgent(OpenCode):
    """OpenCode Harbor agent variant that pins the run title.

    Harbor 0.13.2 invokes `opencode --model=... run` without a title. In this
    local environment that can trigger default small-model title generation
    before the actual task run. This variant keeps Harbor's install and ATIF
    parsing behavior but starts OpenCode as `opencode run -m ... --title ...`.
    """

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._instruction = instruction
        escaped_instruction = shlex.quote(instruction)

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, model_id = self.model_name.split("/", 1)
        env = {
            "OPENCODE_FAKE_VCS": "git",
            "OPENCODE_HARBOR_PROVIDER": provider,
            "OPENCODE_HARBOR_MODEL": model_id,
        }

        provider_env_keys = {
            "deepseek": ["DEEPSEEK_API_KEY"],
            "opencode": ["OPENCODE_API_KEY"],
            "openai": ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
            "zhipuai-coding-plan": [
                "ZHIPUAI_CODING_PLAN_API_KEY",
                "ZHIPUAI_API_KEY",
                "ZAI_CODING_PLAN_API_KEY",
                "ZAI_API_KEY",
                "OPENAI_API_KEY",
            ],
            "zai-coding-plan": [
                "ZAI_CODING_PLAN_API_KEY",
                "ZAI_API_KEY",
                "ZHIPUAI_CODING_PLAN_API_KEY",
                "ZHIPUAI_API_KEY",
                "OPENAI_API_KEY",
            ],
            "anthropic": ["ANTHROPIC_API_KEY"],
            "google": [
                "GEMINI_API_KEY",
                "GOOGLE_GENERATIVE_AI_API_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_CLOUD_PROJECT",
                "GOOGLE_CLOUD_LOCATION",
                "GOOGLE_GENAI_USE_VERTEXAI",
                "GOOGLE_API_KEY",
            ],
        }
        for key in provider_env_keys.get(provider, []):
            if key in os.environ:
                env[key] = os.environ[key]

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)

        config_command = self._build_register_config_command()
        if config_command:
            await self.exec_as_agent(environment, command=config_command, env=env)

        if provider in {"zhipuai-coding-plan", "zai-coding-plan"}:
            await self.exec_as_agent(
                environment,
                command=(
                    ". ~/.nvm/nvm.sh; node <<'NODE'\n"
                    "const fs = require('fs');\n"
                    "const os = require('os');\n"
                    "const path = require('path');\n"
                    "const provider = process.env.OPENCODE_HARBOR_PROVIDER;\n"
                    "const model = process.env.OPENCODE_HARBOR_MODEL;\n"
                    "const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');\n"
                    "let config = {};\n"
                    "try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}\n"
                    "config.provider ??= {};\n"
                    "config.provider[provider] ??= {};\n"
                    "config.provider[provider].models ??= {};\n"
                    "config.provider[provider].models[model] ??= {};\n"
                    "const apiKey = process.env.ZHIPUAI_CODING_PLAN_API_KEY ||\n"
                    "  process.env.ZHIPUAI_API_KEY ||\n"
                    "  process.env.ZAI_CODING_PLAN_API_KEY ||\n"
                    "  process.env.ZAI_API_KEY ||\n"
                    "  process.env.OPENAI_API_KEY;\n"
                    "if (apiKey) {\n"
                    "  config.provider[provider].options ??= {};\n"
                    "  config.provider[provider].options.apiKey = apiKey;\n"
                    "}\n"
                    "fs.mkdirSync(path.dirname(configPath), { recursive: true });\n"
                    "fs.writeFileSync(configPath, JSON.stringify(config, null, 2));\n"
                    "NODE"
                ),
                env=env,
            )

        cli_flags = self.build_cli_flags()
        cli_flags_arg = (cli_flags + " ") if cli_flags else ""
        model = shlex.quote(self.model_name)

        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                f"opencode run -m {model} --pure --title harbor-terminal-bench-smoke "
                f"--format=json {cli_flags_arg}--thinking --dangerously-skip-permissions "
                f"-- {escaped_instruction} "
                f"2>&1 </dev/null | stdbuf -oL tee /logs/agent/opencode.txt"
            ),
            env=env,
        )

        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError(
                "OpenCode emitted error event(s): " + "; ".join(messages[:3])
            )
