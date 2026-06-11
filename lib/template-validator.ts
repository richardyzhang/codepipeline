/**
 * Pure TypeScript validation module for CloudFormation templates.
 *
 * Contains data model interfaces and static validation logic for JSON syntax
 * and CloudFormation structural rules. This module has no AWS SDK dependencies
 * and is fully unit-testable and property-testable.
 */

/**
 * Describes a single validation error found in a template.
 */
export interface ValidationError {
  errorType: 'json_syntax' | 'missing_resources' | 'invalid_top_level_key' | 'file_not_found' | 'api_error';
  message: string;
  location?: string;
}

/**
 * Result of validating a single template.
 */
export interface TemplateValidationResult {
  templatePath: string;
  status: 'passed' | 'failed';
  errors: ValidationError[];
}

/**
 * Aggregate counts for a batch validation run.
 */
export interface ReportSummary {
  totalTemplates: number;
  passed: number;
  failed: number;
  status: 'passed' | 'failed' | 'skipped';
}

/**
 * Per-template result entry in the validation report.
 */
export interface TemplateResult {
  templatePath: string;
  status: 'passed' | 'failed';
  errors: ValidationError[];
}

/**
 * Full validation report produced by batch validation.
 */
export interface ValidationReport {
  summary: ReportSummary;
  results: TemplateResult[];
}

/**
 * The complete set of valid CloudFormation top-level template keys.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-anatomy.html
 */
export const VALID_CFN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'AWSTemplateFormatVersion',
  'Description',
  'Metadata',
  'Parameters',
  'Rules',
  'Mappings',
  'Conditions',
  'Transform',
  'Resources',
  'Outputs',
]);

/**
 * Validates that a string is well-formed JSON.
 *
 * No file I/O — the caller reads the file and passes the content string.
 *
 * @param content - Raw file content to parse as JSON
 * @param templatePath - Path to the template (used in the result metadata)
 * @returns A TemplateValidationResult indicating pass or fail with error details
 */
export function validateJsonSyntax(content: string, templatePath: string): TemplateValidationResult {
  try {
    JSON.parse(content);
    return { templatePath, status: 'passed', errors: [] };
  } catch (err) {
    const syntaxError = err as SyntaxError;
    const message = syntaxError.message || 'Invalid JSON';

    // Attempt to extract line/column from the error message.
    // V8 errors typically look like: "... at position 42" or "... at line X column Y"
    let location: string | undefined;
    const lineColMatch = message.match(/line (\d+) column (\d+)/i);
    if (lineColMatch) {
      location = `line ${lineColMatch[1]}, column ${lineColMatch[2]}`;
    } else {
      const positionMatch = message.match(/position (\d+)/i);
      if (positionMatch) {
        const position = parseInt(positionMatch[1], 10);
        // Convert byte position to line/column
        const upToPosition = content.slice(0, position);
        const line = upToPosition.split('\n').length;
        const lastNewline = upToPosition.lastIndexOf('\n');
        const column = position - lastNewline;
        location = `line ${line}, column ${column}`;
      }
    }

    return {
      templatePath,
      status: 'failed',
      errors: [
        {
          errorType: 'json_syntax',
          message,
          ...(location && { location }),
        },
      ],
    };
  }
}

/**
 * Validates that a parsed template object has valid CloudFormation structure:
 * - Contains a top-level "Resources" key
 * - All top-level keys are in the valid set
 *
 * @param template - The parsed template object to validate
 * @param templatePath - The file path of the template (for reporting)
 * @returns A TemplateValidationResult indicating pass/fail with any errors
 */
export function validateTemplateStructure(
  template: Record<string, unknown>,
  templatePath: string,
): TemplateValidationResult {
  const errors: ValidationError[] = [];

  // Check for required "Resources" key
  if (!Object.prototype.hasOwnProperty.call(template, 'Resources')) {
    errors.push({
      errorType: 'missing_resources',
      message: 'Template is missing the required top-level "Resources" key',
    });
  }

  // Check all top-level keys are valid
  const invalidKeys = Object.keys(template).filter(
    (key) => !VALID_CFN_TOP_LEVEL_KEYS.has(key),
  );

  if (invalidKeys.length > 0) {
    errors.push({
      errorType: 'invalid_top_level_key',
      message: `Template contains invalid top-level keys: ${invalidKeys.join(', ')}`,
      location: invalidKeys.join(', '),
    });
  }

  return {
    templatePath,
    status: errors.length > 0 ? 'failed' : 'passed',
    errors,
  };
}

/**
 * Runs all static validations (JSON syntax + structure) on raw file content.
 *
 * Executes `validateJsonSyntax` first — if the content is not valid JSON, returns
 * early with the syntax error (structure validation is skipped). If JSON is valid,
 * runs `validateTemplateStructure` and merges errors from both stages.
 *
 * @param content - Raw file content to validate
 * @param templatePath - Path to the template (used in result metadata)
 * @returns A combined TemplateValidationResult
 */
export function validateTemplate(content: string, templatePath: string): TemplateValidationResult {
  const syntaxResult = validateJsonSyntax(content, templatePath);

  // If JSON parsing failed, return early — no point checking structure
  if (syntaxResult.status === 'failed') {
    return syntaxResult;
  }

  // JSON is valid; parse the object and run structure validation
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const structureResult = validateTemplateStructure(parsed, templatePath);

  // Merge errors from both stages
  const allErrors = [...syntaxResult.errors, ...structureResult.errors];

  return {
    templatePath,
    status: allErrors.length > 0 ? 'failed' : 'passed',
    errors: allErrors,
  };
}

/**
 * Validates a batch of templates and produces a ValidationReport.
 *
 * For each template in the input:
 * - If `content` is `null`, records a `'file_not_found'` error
 * - Otherwise, runs the full static validation via `validateTemplate`
 *
 * If the input array is empty, returns a report with zero entries and status `'skipped'`.
 *
 * @param templates - Array of template entries with path and content (null if file missing)
 * @returns A ValidationReport with summary and per-template results
 */
export function validateTemplates(
  templates: Array<{ path: string; content: string | null }>,
): ValidationReport {
  // Handle empty input: return report with skipped status
  if (templates.length === 0) {
    return {
      summary: {
        totalTemplates: 0,
        passed: 0,
        failed: 0,
        status: 'skipped',
      },
      results: [],
    };
  }

  const results: TemplateResult[] = [];

  for (const template of templates) {
    if (template.content === null) {
      // File not found — record error and mark as failed
      results.push({
        templatePath: template.path,
        status: 'failed',
        errors: [
          {
            errorType: 'file_not_found',
            message: `Template file not found: ${template.path}`,
          },
        ],
      });
    } else {
      // Run full static validation
      const result = validateTemplate(template.content, template.path);
      results.push({
        templatePath: result.templatePath,
        status: result.status,
        errors: result.errors,
      });
    }
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return {
    summary: {
      totalTemplates: results.length,
      passed,
      failed,
      status: failed > 0 ? 'failed' : 'passed',
    },
    results,
  };
}
