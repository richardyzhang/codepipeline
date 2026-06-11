import {
  deriveStackName,
  extractFolder,
  isJsonTemplate,
  shouldAssumeRole,
  buildRoleArn,
} from '../lib/codebuild/utils';

describe('deriveStackName', () => {
  it('derives name from folder and filename', () => {
    expect(deriveStackName('dev/ec2.json')).toBe('dev-ec2');
    expect(deriveStackName('prod/ec2.json')).toBe('prod-ec2');
  });

  it('uses immediate parent folder for nested paths', () => {
    expect(deriveStackName('nested/deep/vpc.json')).toBe('deep-vpc');
    expect(deriveStackName('a/b/c/template.json')).toBe('c-template');
  });

  it('handles root-level files with no folder', () => {
    expect(deriveStackName('ec2.json')).toBe('ec2');
  });

  it('strips various extensions', () => {
    expect(deriveStackName('dev/vpc.yaml')).toBe('dev-vpc');
    expect(deriveStackName('dev/stack.yml')).toBe('dev-stack');
    expect(deriveStackName('dev/app.template')).toBe('dev-app');
  });

  it('replaces invalid characters with hyphens', () => {
    expect(deriveStackName('dev/my_stack.json')).toBe('dev-my-stack');
    expect(deriveStackName('dev/my stack.json')).toBe('dev-my-stack');
  });

  it('prepends cfn- if first char is not a letter', () => {
    expect(deriveStackName('123/ec2.json')).toBe('cfn-123-ec2');
    expect(deriveStackName('dev/123stack.json')).toBe('dev-123stack');
  });

  it('truncates to 128 characters', () => {
    const longFolder = 'a'.repeat(100);
    const longFile = 'b'.repeat(100);
    const result = deriveStackName(`${longFolder}/${longFile}.json`);
    expect(result.length).toBeLessThanOrEqual(128);
  });
});

describe('extractFolder', () => {
  it('extracts the first path segment', () => {
    expect(extractFolder('dev/ec2.json')).toBe('dev');
    expect(extractFolder('prod/vpc.json')).toBe('prod');
  });

  it('returns first segment for nested paths', () => {
    expect(extractFolder('dev/nested/deep.json')).toBe('dev');
  });

  it('returns empty string for root-level files', () => {
    expect(extractFolder('ec2.json')).toBe('');
  });
});

describe('isJsonTemplate', () => {
  it('returns true for .json files', () => {
    expect(isJsonTemplate('dev/ec2.json')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isJsonTemplate('dev/ec2.JSON')).toBe(true);
    expect(isJsonTemplate('dev/ec2.Json')).toBe(true);
  });

  it('returns false for non-JSON files', () => {
    expect(isJsonTemplate('dev/ec2.yaml')).toBe(false);
    expect(isJsonTemplate('dev/ec2.yml')).toBe(false);
    expect(isJsonTemplate('README.md')).toBe(false);
  });
});

describe('shouldAssumeRole', () => {
  it('returns true when accounts differ', () => {
    expect(shouldAssumeRole('237713356231', '912333642649')).toBe(true);
  });

  it('returns false when accounts are the same', () => {
    expect(shouldAssumeRole('912333642649', '912333642649')).toBe(false);
  });
});

describe('buildRoleArn', () => {
  it('returns correctly formatted role ARN', () => {
    expect(buildRoleArn('237713356231')).toBe(
      'arn:aws:iam::237713356231:role/githubExecutionRole'
    );
  });

  it('includes the target account ID in the ARN', () => {
    const arn = buildRoleArn('123456789012');
    expect(arn).toContain('123456789012');
    expect(arn).toBe('arn:aws:iam::123456789012:role/githubExecutionRole');
  });
});
