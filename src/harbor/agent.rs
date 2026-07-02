use crate::harbor::economy_mode::HarborEconomyMode;
use crate::harbor::task_classifier::TaskClassifier;

/// Configuration for Harbor agent
#[derive(Debug, Clone)]
pub struct HarborConfig {
    /// Economy mode for execution
    pub economy_mode: HarborEconomyMode,
    /// Maximum tool output length (None for unlimited)
    pub max_tool_output_length: Option<usize>,
    /// Whether to skip redundant verification steps
    pub skip_redundant_verification: bool,
    /// Whether to use concise prompt templates
    pub use_concise_prompts: bool,
}

impl Default for HarborConfig {
    fn default() -> Self {
        Self {
            economy_mode: HarborEconomyMode::default(),
            max_tool_output_length: None,
            skip_redundant_verification: false,
            use_concise_prompts: false,
        }
    }
}

impl HarborConfig {
    /// Create a new economy mode configuration
    pub fn economy() -> Self {
        Self {
            economy_mode: HarborEconomyMode::Economy,
            max_tool_output_length: Some(2000),
            skip_redundant_verification: true,
            use_concise_prompts: true,
        }
    }

    /// Auto-detect the best configuration based on task characteristics
    pub fn auto_detect(
        task_type: &str,
        input_size: usize,
        expected_output_structure: &str,
    ) -> Self {
        let mode = TaskClassifier::classify(task_type, input_size, expected_output_structure);
        match mode {
            HarborEconomyMode::Economy => Self::economy(),
            HarborEconomyMode::Standard => Self::default(),
        }
    }
}

/// Harbor agent with economy mode support
pub struct HarborAgent {
    config: HarborConfig,
}

impl HarborAgent {
    /// Create a new Harbor agent with the given configuration
    pub fn new(config: HarborConfig) -> Self {
        Self { config }
    }

    /// Create a new Harbor agent with auto-detected configuration
    pub fn auto(task_type: &str, input_size: usize, expected_output_structure: &str) -> Self {
        let config = HarborConfig::auto_detect(task_type, input_size, expected_output_structure);
        Self::new(config)
    }

    /// Execute a task with the agent
    pub async fn execute(&self, task: &str) -> Result<String, HarborError> {
        // Build prompt based on configuration
        let prompt = if self.config.use_concise_prompts {
            self.build_concise_prompt(task)
        } else {
            self.build_standard_prompt(task)
        };

        // Execute the task
        let result = self.run_with_prompt(&prompt).await?;

        // Apply output truncation if in economy mode
        if let Some(max_length) = self.config.max_tool_output_length {
            Ok(self.truncate_output(&result, max_length))
        } else {
            Ok(result)
        }
    }

    /// Build a concise prompt for economy mode
    fn build_concise_prompt(&self, task: &str) -> String {
        format!(
            "Task: {}\n\n\
             Instructions:\n\
             - Solve this task efficiently\n\
             - Use minimal tool calls\n\
             - Return only the final result\n\
             - No verbose output or explanations needed",
            task
        )
    }

    /// Build a standard prompt
    fn build_standard_prompt(&self, task: &str) -> String {
        format!(
            "Task: {}\n\n\
             Instructions:\n\
             - Solve this task step by step\n\
             - Verify your work at each step\n\
             - Provide detailed output\n\
             - Include explanations where helpful",
            task
        )
    }

    /// Truncate tool output to the specified maximum length
    fn truncate_output(&self, output: &str, max_length: usize) -> String {
        if output.len() <= max_length {
            output.to_string()
        } else {
            let truncated = &output[..max_length];
            format!("{}... [truncated {} characters]", truncated, output.len() - max_length)
        }
    }

    /// Run the agent with the given prompt
    async fn run_with_prompt(&self, prompt: &str) -> Result<String, HarborError> {
        // This would integrate with the actual LLM/tool execution
        // For now, return a placeholder
        Ok(format!("Executed with prompt: {}", prompt))
    }
}

#[derive(Debug)]
pub struct HarborError(String);

impl std::fmt::Display for HarborError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Harbor error: {}", self.0)
    }
}

impl std::error::Error for HarborError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_economy_mode_execution() {
        let agent = HarborAgent::new(HarborConfig::economy());
        let result = agent.execute("convert log file to csv").await.unwrap();
        assert!(result.contains("concise"));
    }

    #[tokio::test]
    async fn test_auto_detect_simple_task() {
        let agent = HarborAgent::auto("transform", 5000, "simple csv");
        assert!(agent.config.use_concise_prompts);
        assert!(agent.config.skip_redundant_verification);
    }

    #[test]
    fn test_truncate_output() {
        let agent = HarborAgent::new(HarborConfig::economy());
        let long_output = "a".repeat(5000);
        let truncated = agent.truncate_output(&long_output, 2000);
        assert!(truncated.len() <= 2000 + 50); // Allow for truncation message
        assert!(truncated.contains("truncated"));
    }
}