/**
 * Commit message rules (FND-015).
 *
 * The subject names a scope that exists as a package, because "fix: stuff" is
 * useless in a release changelog that has to say what changed where.
 */
export default {
  // Keep the rules self-contained: bunx installs the CLI, not a separate shareable config.
  rules: {
    'type-empty': [2, 'never'],
    'type-case': [2, 'always', 'lower-case'],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'scope-case': [2, 'always', 'lower-case'],
    'body-leading-blank': [1, 'always'],
    'body-max-line-length': [2, 'always', 100],
    'footer-leading-blank': [1, 'always'],
    'footer-max-line-length': [2, 'always', 100],
    'scope-empty': [2, 'never'],
    'scope-enum': [
      2,
      'always',
      [
        'router',
        'http',
        'validate',
        'core',
        'container',
        'config',
        'console',
        'testing',
        'frontpage',
        'tools',
        'ci',
        'release',
        'deps',
        'repo',
      ],
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 100],
  },
};
