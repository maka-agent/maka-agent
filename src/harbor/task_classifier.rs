use crate::harbor::economy_mode::HarborEconomyMode;

/// Classifies Terminal-Bench tasks to determine appropriate economy mode
pub struct TaskClassifier;

impl TaskClassifier {
    /// Classify a task based on its characteristics
    pub fn classify(
        task_type: &str,
        input_size: usize,
        expected_output_structure: &str,
    ) -> HarborEconomyMode {
        // Simple data-transform tasks are good candidates for economy mode
        if Self::is_simple_data_transform(task_type, input_size, expected_output_structure) {
            HarborEconomyMode::Economy
        } else {
            HarborEconomyMode::Standard
        }
    }

    /// Determine if a task is a simple data-transform task
    fn is_simple_data_transform(
        task_type: &str,
        input_size: usize,
        expected_output_structure: &str,
    ) -> bool {
        // Heuristics for simple data-transform tasks:
        // 1. Task type contains "transform", "convert", "parse", "extract", "summarize"
        // 2. Input size is small (< 10KB)
        // 3. Expected output is a simple structure (flat, not nested)
        
        let is_transform_type = matches!(
            task_type.to_lowercase().as_str(),
            "transform" | "convert" | "parse" | "extract" | "summarize" | "filter" | "map"
        );

        let is_small_input = input_size < 10_240; // 10KB
        let is_simple_output = !expected_output_structure.contains('{') 
            && !expected_output_structure.contains('[')
            && expected_output_structure.len() < 500;

        is_transform_type && is_small_input && is_simple_output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_simple_transform() {
        let mode = TaskClassifier::classify("transform", 5000, "csv with 3 columns");
        assert_eq!(mode, HarborEconomyMode::Economy);
    }

    #[test]
    fn test_classify_complex_task() {
        let mode = TaskClassifier::classify("analyze", 50000, "nested json with arrays");
        assert_eq!(mode, HarborEconomyMode::Standard);
    }

    #[test]
    fn test_classify_large_input() {
        let mode = TaskClassifier::classify("transform", 20000, "simple text");
        assert_eq!(mode, HarborEconomyMode::Standard);
    }
}