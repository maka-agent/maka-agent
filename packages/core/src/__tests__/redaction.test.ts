import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { categorizeBash } from '../permission.js';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  redactBashCommandSecretsForCriticalReview,
  redactSecrets,
  redactSecretsForCriticalReview,
} from '../redaction.js';

const GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const GIT_RESET_COMMAND = `git reset --hard ${GIT_COMMIT_SHA}`;

describe('redactSecrets', () => {
  test('masks proven sensitive spans without discarding unsupported suffixes', () => {
    const cases = [
      ['auth=opaque', 'auth=[redacted]'],
      ['"password"=opaque-secret', '"password"=[redacted]'],
      ['Authorization: Bearer bearer-opaque-value', 'Authorization: Bearer [redacted]'],
      ['"Authorization": Basic basic-opaque-value', '"Authorization": Basic [redacted]'],
      ["'Authorization': Token token-opaque-value", "'Authorization': Token [redacted]"],
      [
        'https://x.test/?model=x&api_key=secret-value&timeout=30',
        'https://x.test/?model=x&api_key=[redacted]&timeout=30',
      ],
      ['https://x.test/?token="abc def&timeout=30"', 'https://x.test/?token="[redacted]"'],
      ['password="correct;horse|battery"', 'password="[redacted]"'],
      ['token=[redacted]actual-secret; keep=safe', 'token=[redacted]; keep=safe'],
      ['password="correct"horse; keep=safe', 'password="[redacted]"; keep=safe'],
      ['ghp_abcdefghijklmnopqrstuvwxyz', '[redacted]'],
      [GIT_RESET_COMMAND, 'git reset --hard [redacted]'],
    ] as const;

    for (const [raw, expected] of cases) {
      const redacted = redactSecrets(raw);
      assert.equal(redacted, expected);
      assert.equal(redactSecrets(redacted), redacted);
    }
  });

  test('continues scanning after partial secrets across multiple lines', () => {
    const raw = [
      'token=alpha/opaque-tail',
      'visible after first',
      'password=beta*opaque-tail',
      'visible after second',
    ].join('\n');
    const expected = [
      'token=[redacted]',
      'visible after first',
      'password=[redacted]',
      'visible after second',
    ].join('\n');

    assert.equal(redactSecrets(raw), expected);
    assert.equal(redactSecrets(expected), expected);
    assert.equal(redactSecretsForCriticalReview(raw), undefined);
  });

  test('structurally masks sensitive values in complete serialized JSON', () => {
    const redacted = redactSecrets(
      JSON.stringify({
        password: 'abc"def\\ghi',
        token: 12345,
        secret: { nested: 'opaque' },
        values: [{ accessToken: true }],
        keep: 'visible',
      }),
    );

    assert.deepEqual(JSON.parse(redacted), {
      password: '[redacted]',
      token: '[redacted]',
      secret: '[redacted]',
      values: [{ accessToken: '[redacted]' }],
      keep: 'visible',
    });
    assert.equal(redacted.includes('opaque'), false);
    assert.equal(redactSecrets(redacted), redacted);
  });

  test('critical generic review accepts only complete literal secret values', () => {
    const cases = [
      ['token=sk-live_secret-1', 'token=REDACTED'],
      ['"password"="ghp_abcdefghijklmnop"', '"password"="REDACTED"'],
      ['Authorization: Bearer bearer_opaque-1', 'Authorization: Bearer REDACTED'],
      ['Authorization: Token 12345', 'Authorization: Token REDACTED'],
      ['Authorization: Basic dXNlcjpwYXNz=', 'Authorization: Basic REDACTED'],
      ['Authorization: "Basic dXNlcjpwYXNz="', 'Authorization: "Basic REDACTED"'],
      [
        'https://x.test/?token=jwt.header_payload-1&keep=yes',
        'https://x.test/?token=REDACTED&keep=yes',
      ],
      ['{"token":"opaque-token"}', '{"token":"REDACTED"}'],
      [String.raw`{\"token\":\"opaque-token\"}`, String.raw`{\"token\":\"REDACTED\"}`],
      [
        '{"Authorization":"Bearer bearer-token_1","keep":"visible"}',
        '{"Authorization":"Bearer REDACTED","keep":"visible"}',
      ],
      [
        String.raw`{\"Authorization\":\"Bearer bearer-token_1\",\"keep\":\"visible\"}`,
        String.raw`{\"Authorization\":\"Bearer REDACTED\",\"keep\":\"visible\"}`,
      ],
    ] as const;

    for (const [raw, expected] of cases) {
      assert.equal(redactSecretsForCriticalReview(raw), expected);
      assert.equal(redactSecretsForCriticalReview(expected), expected);
    }
  });

  test('critical hex handling is contextual to literal Git object arguments', () => {
    for (const length of [39, 40, 41, 63, 64, 65, 80]) {
      const objectId = 'a'.repeat(length);
      const nonGit = `echo ${objectId}`;
      const git = `git show ${objectId}`;

      assert.equal(
        redactSecrets(`value=${objectId}; keep=safe`),
        length < 40 ? `value=${objectId}; keep=safe` : 'value=[redacted]; keep=safe',
      );
      assert.equal(redactSecretsForCriticalReview(nonGit), length < 40 ? nonGit : undefined);
      assert.equal(
        redactBashCommandSecretsForCriticalReview(nonGit),
        length < 40 ? nonGit : undefined,
      );
      assert.equal(
        redactBashCommandSecretsForCriticalReview(git),
        length === 39 || length === 40 || length === 64 ? git : undefined,
      );

      if (length === 40 || length === 64) {
        assert.equal(
          redactBashCommandSecretsForCriticalReview(`echo "prefix; git show ${objectId}"`),
          undefined,
        );
      }
    }
  });

  test('leaves closed empty sensitive fields unchanged and continues scanning', () => {
    for (const raw of [
      'TOKEN=',
      "TOKEN=''",
      'TOKEN=""',
      'Authorization: Bearer',
      '{"token":"","authorization":"Bearer","keep":"visible"}',
    ]) {
      assert.equal(redactSecrets(raw), raw);
      assert.equal(redactSecretsForCriticalReview(raw), raw);
    }

    for (const command of [
      'TOKEN=',
      "TOKEN=''",
      'TOKEN=""',
      'Authorization: Bearer',
      `echo '{"token":"","authorization":"Bearer","keep":"visible"}'`,
      'vendor-cli --token=',
      "vendor-cli --token ''",
      'vendor-cli --token\nopaque-secret; rm foo',
    ]) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), command);
      assert.equal(redactSecrets(command), command);
    }

    assert.equal(
      redactBashCommandSecretsForCriticalReview(
        `TOKEN=''; TOKEN=""; TOKEN=; Authorization: Basic; echo token=opaque`,
      ),
      `TOKEN=''; TOKEN=""; TOKEN=; Authorization: Basic; echo token=REDACTED`,
    );
  });
});

describe('critical Bash review redaction', () => {
  test('replaces safe literal forms without changing command category', () => {
    const cases = [
      ['echo token=sk-live_secret-1; rm foo', 'echo token=REDACTED; rm foo'],
      ['echo password="ghp_abcdefghijklmnop"; rm foo', 'echo password="REDACTED"; rm foo'],
      [
        'vendor-cli --api-key=opaque-secret --mode review; rm foo',
        'vendor-cli --api-key=REDACTED --mode review; rm foo',
      ],
      [
        'vendor-cli --token opaque-secret --mode review; rm foo',
        'vendor-cli --token REDACTED --mode review; rm foo',
      ],
      [
        "vendor-cli --password 'opaque-secret' --mode review; rm foo",
        'vendor-cli --password REDACTED --mode review; rm foo',
      ],
      [
        'echo "Authorization": Basic basic_opaque-1; rm foo',
        'echo "Authorization": Basic REDACTED; rm foo',
      ],
      [
        'echo https://x.test/?token=jwt.header_payload-1&timeout=30; rm foo',
        'echo https://x.test/?token=REDACTED&timeout=30; rm foo',
      ],
      [`echo '{"token":"opaque-token"}'; rm foo`, `echo '{"token":"REDACTED"}'; rm foo`],
      [
        String.raw`echo "{\"token\":\"opaque-token\"}"; rm foo`,
        String.raw`echo "{\"token\":\"REDACTED\"}"; rm foo`,
      ],
      [
        "curl -H 'Authorization: Bearer bearer-token_1' https://example.test; rm foo",
        "curl -H 'Authorization: Bearer REDACTED' https://example.test; rm foo",
      ],
      [
        'curl -H "Authorization: Basic dXNlcjpwYXNz=" https://example.test; rm foo',
        'curl -H "Authorization: Basic REDACTED" https://example.test; rm foo',
      ],
    ] as const;

    for (const [command, expected] of cases) {
      const redacted = redactBashCommandSecretsForCriticalReview(command);
      assert.equal(redacted, expected);
      assert.equal(redactBashCommandSecretsForCriticalReview(expected), expected);
      assert.equal(categorizeBash(redacted!), categorizeBash(command));
      assert.equal(redacted!.includes('opaque'), false);
      assert.equal(redacted!.includes('sk-live_secret-1'), false);
      assert.equal(redacted!.includes('ghp_abcdefghijklmnop'), false);
      assert.equal(redacted!.includes('; rm foo'), true);
    }

    assert.equal(
      redactSecrets('vendor-cli --api-key=opaque-secret --mode review; rm foo'),
      "vendor-cli --api-key='[redacted]' --mode review; rm foo",
    );
  });

  test('canonicalizes complete static sensitive long-option words', () => {
    const cases = [
      [
        "vendor-cli --api-key''=opaque-secret --mode review; rm foo",
        'vendor-cli --api-key=REDACTED --mode review; rm foo',
        "vendor-cli --api-key='[redacted]' --mode review; rm foo",
      ],
      [
        "vendor-cli --api'-'key=opaque-secret --mode review; rm foo",
        'vendor-cli --api-key=REDACTED --mode review; rm foo',
        "vendor-cli --api-key='[redacted]' --mode review; rm foo",
      ],
      [
        "vendor-cli --api-key=opaque''-secret --mode review; rm foo",
        'vendor-cli --api-key=REDACTED --mode review; rm foo',
        "vendor-cli --api-key='[redacted]' --mode review; rm foo",
      ],
      [
        'vendor-cli "--token"=opaque-secret --mode review; rm foo',
        'vendor-cli --token=REDACTED --mode review; rm foo',
        "vendor-cli --token='[redacted]' --mode review; rm foo",
      ],
      [
        "vendor-cli --token'='opaque-secret --mode review; rm foo",
        'vendor-cli --token=REDACTED --mode review; rm foo',
        "vendor-cli --token='[redacted]' --mode review; rm foo",
      ],
      [
        'vendor-cli "--token=opaque-secret"; rm foo',
        'vendor-cli --token=REDACTED; rm foo',
        "vendor-cli --token='[redacted]'; rm foo",
      ],
      [
        String.raw`vendor-cli --password \"opaque-secret\"; rm foo`,
        'vendor-cli --password REDACTED; rm foo',
        "vendor-cli --password '[redacted]'; rm foo",
      ],
    ] as const;

    for (const [command, critical, publicProjection] of cases) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), critical);
      assert.equal(redactSecrets(command), publicProjection);
      assert.equal(redactSecrets(publicProjection), publicProjection);
    }
  });

  test('distinguishes literal line continuations from command boundaries', () => {
    const continued = 'vendor-cli --api-key=opaque\\\n-secret; rm foo';
    const separateLines = 'vendor-cli --api-key=opaque\n-secret; rm foo';

    assert.equal(
      redactBashCommandSecretsForCriticalReview(continued),
      'vendor-cli --api-key=REDACTED; rm foo',
    );
    assert.equal(redactSecrets(continued), "vendor-cli --api-key='[redacted]'; rm foo");
    assert.equal(
      redactBashCommandSecretsForCriticalReview(separateLines),
      'vendor-cli --api-key=REDACTED\n-secret; rm foo',
    );
  });

  test('fails critical review closed for ambiguous long-option expansion', () => {
    const cases = [
      ["vendor-cli --api-key''=${OPAQUE_SECRET}; rm foo", "vendor-cli '[redacted]'; rm foo"],
      ['vendor-cli --api-$PART=opaque-secret; rm foo', "vendor-cli '[redacted]'; rm foo"],
      ['vendor-cli $(true)"--to"ken=opaque-secret; rm foo', "vendor-cli '[redacted]'; rm foo"],
      ["vendor-cli $'--to'ken=opaque-secret; rm foo", "vendor-cli '[redacted]'; rm foo"],
      [
        'vendor-cli $(echo --token=inner-secret) --output=safe; rm foo',
        "vendor-cli '[redacted]' --output=safe; rm foo",
      ],
    ] as const;

    for (const [command, publicProjection] of cases) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), undefined);
      assert.equal(redactSecrets(command), publicProjection);
    }
  });

  test('treats possible sensitive brace and pathname expansions as dynamic', () => {
    const cases = [
      [
        'vendor-cli --to{ke,ke}n=opaque-secret --mode review; rm foo',
        "vendor-cli '[redacted]' --mode review; rm foo",
      ],
      [
        'vendor-cli --to*n=opaque-secret --mode review; rm foo',
        "vendor-cli '[redacted]' --mode review; rm foo",
      ],
    ] as const;

    for (const [command, publicProjection] of cases) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), undefined);
      assert.equal(redactSecrets(command), publicProjection);
    }

    const unrelated = 'vendor-cli --output=*.txt --mode review';
    assert.equal(redactBashCommandSecretsForCriticalReview(unrelated), unrelated);
    assert.equal(redactSecrets(unrelated), unrelated);

    const afterDynamicWord = 'vendor-cli $FLAGS --token=opaque-secret; rm foo';
    assert.equal(
      redactBashCommandSecretsForCriticalReview(afterDynamicWord),
      'vendor-cli $FLAGS --token=REDACTED; rm foo',
    );
    assert.equal(redactSecrets(afterDynamicWord), "vendor-cli $FLAGS --token='[redacted]'; rm foo");
  });

  test('rejects unsupported critical syntax while public redaction preserves later content', () => {
    const cases = [
      ['command substitution', 'echo token=$(printf opaque-substitution); rm foo', '; rm foo'],
      ['inner quote', "echo token=abc'def'; rm foo", '; rm foo'],
      ['outer-quoted suffix', 'echo "token=abc def"; rm foo', '; rm foo'],
      ['adjacent suffix', 'echo token=abc/def; rm foo', '; rm foo'],
      ['glob', 'echo token=abc*def; rm foo', '; rm foo'],
      ['control', 'echo token=abc\u0000def; rm foo', '; rm foo'],
      [
        'escaped Unicode key',
        String.raw`echo "{\"to\\u006ben\":\"opaque-token\"}"; rm foo`,
        '; rm foo',
      ],
      ['escaped payload', String.raw`echo "{\"token\":\"abc\\\"def\"}"; rm foo`, '; rm foo'],
      [
        'multiply escaped member',
        String.raw`echo "\\\"token\\\":\\\"opaque-token\\\""; rm foo`,
        '; rm foo',
      ],
      [
        'escaped container',
        String.raw`echo "{\"token\":{\"nested\":\"opaque-container\"}}"; rm foo`,
        '; rm foo',
      ],
      [
        'long option value concatenation',
        'vendor-cli --token=opaque"$TOKEN_SUFFIX"; rm foo',
        '; rm foo',
      ],
      ['heredoc', 'cat <<EOF\ntoken=opaque-heredoc\nEOF', '\nEOF'],
      ['high-confidence provider token', 'echo ghp_abcdefghijklmnopqrstuvwxyz; rm foo', '; rm foo'],
    ] as const;

    for (const [label, command, preservedSuffix] of cases) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), undefined, label);
      const generic = redactSecrets(command);
      assert.equal(generic.includes('[redacted]'), true, label);
      assert.equal(generic.includes(preservedSuffix), true, label);
      assert.equal(redactSecrets(generic), generic, label);
    }

    assert.equal(redactSecrets('echo "token=abc def"; rm foo'), 'echo "token=[redacted]"; rm foo');
    for (const command of [
      'echo token=$(printf opaque-substitution); rm foo',
      'echo token=$(printf opaque; printf suffix); rm foo',
      'echo token=${opaque value}; rm foo',
      'echo token=`printf opaque-value`; rm foo',
    ]) {
      assert.equal(redactSecrets(command), 'echo token=[redacted]; rm foo');
    }
  });

  test('returns complex commands verbatim when no sensitive occurrence exists', () => {
    const commands = [
      String.raw`printf "note \"open"; curl -X POST https://example.test/upload`,
      'cat <<EOF\nordinary data\nEOF',
      'vendor-cli --verbose -t ordinary-value',
      'vendor-cli $FLAGS',
      GIT_RESET_COMMAND,
    ];

    for (const command of commands) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), command);
    }
    assert.equal(categorizeBash(GIT_RESET_COMMAND), 'git_destructive');
  });

  test('resets literal proof only at top-level boundaries after quotes, expansions, and backticks', () => {
    for (const command of [
      'echo "$HOME"; echo token=outer-secret',
      'echo $(date); echo token=outer-secret',
      'echo ${HOME}; echo token=outer-secret',
      'echo `date`; echo token=outer-secret',
    ]) {
      assert.equal(
        redactBashCommandSecretsForCriticalReview(command),
        command.replace('token=outer-secret', 'token=REDACTED'),
      );
    }

    for (const command of [
      'echo "$HOME" token=outer-secret',
      'echo $(date; token=inner-secret); echo token=outer-secret',
      'echo $(date; token="inner-secret" ); echo token=outer-secret',
      'echo ${token=inner-secret}; echo token=outer-secret',
      'echo ${token="inner-secret" }; echo token=outer-secret',
      'echo `token=inner-secret`; echo token=outer-secret',
      'echo `token="inner-secret" `; echo token=outer-secret',
    ]) {
      assert.equal(redactBashCommandSecretsForCriticalReview(command), undefined);
    }
  });
});

describe('generalized error messages', () => {
  test('returns generic English classes without secret content', () => {
    assert.equal(
      generalizedErrorMessage(new Error('401 Authorization: Bearer bearer-opaque-value')),
      'Authentication failed',
    );
    assert.equal(
      generalizedErrorMessage(new Error('fetch failed ECONNREFUSED token=secret')),
      'Network error',
    );
  });

  test('keeps the Chinese classifier and fallback closed', () => {
    const cases = [
      ['Request timeout after 30s', '请求超时'],
      ['HTTP 429 Too Many Requests', '触发模型速率限制'],
      ['401 Authorization: Bearer bearer-opaque-value', '鉴权失败'],
      ['Provider returned 503', '模型服务返回错误'],
      ['fetch failed', '网络错误'],
      ['unknown failure', '操作失败'],
    ] as const;

    for (const [raw, expected] of cases) {
      assert.equal(generalizedErrorMessageChinese(new Error(raw)), expected);
    }
  });
});
