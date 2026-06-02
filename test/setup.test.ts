import * as fc from 'fast-check';
import * as cdk from 'aws-cdk-lib';

describe('Project setup', () => {
  test('fast-check is available', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        return typeof n === 'number';
      }),
      { numRuns: 10 }
    );
  });

  test('aws-cdk-lib is available', () => {
    const app = new cdk.App();
    expect(app).toBeDefined();
  });
});
