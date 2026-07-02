use serde::{Deserialize, Serialize};

/// Economy mode for Harbor agent execution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HarborEconomyMode {
    /// Standard mode - full verification and verbose output
    Standard,
    /// Economy mode - reduced verification and truncated output for simple tasks
    Economy,
}

impl Default for HarborEconomyMode {
    fn default() -> Self {
        Self::Standard
    }
}

impl HarborEconomyMode {
    /// Returns true if this is economy mode
    pub fn is_economy(&self) -> bool {
        matches!(self, Self::Economy)
    }

    /// Maximum tool output length in economy mode (characters)
    pub fn max_tool_output_length(&self) -> Option<usize> {
        match self {
            Self::Standard => None,
            Self::Economy => Some(2000),
        }
    }

    /// Whether to skip redundant verification steps
    pub fn skip_redundant_verification(&self) -> bool {
        matches!(self, Self::Economy)
    }

    /// Whether to use concise prompt templates
    pub fn use_concise_prompts(&self) -> bool {
        matches!(self, Self::Economy)
    }
}