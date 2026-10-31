/**
 * Commit message rules (FND-015).
 *
 * The subject names a scope that exists as a package, because "fix: stuff" is
 * useless in a release changelog that has to say what changed where.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
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
