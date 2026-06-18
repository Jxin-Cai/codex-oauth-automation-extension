const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/gmail-mail.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function createApi() {
  const bundle = [
    extractFunction('normalizeRulePatternList'),
    extractFunction('findLastRegexCandidate'),
    extractFunction('extractCodeByRulePatterns'),
    extractFunction('extractVerificationCode'),
  ].join('\n');

  return new Function(`
${bundle}
return { extractVerificationCode };
`)();
}

test('gmail extractVerificationCode returns the last Kiro verification code from one message', () => {
  const api = createApi();

  const bodyText = 'AWS Builder ID\nYour verification code is 111222\nYour verification code is 333444';
  assert.equal(
    api.extractVerificationCode(bodyText, {
      codePatterns: [
        {
          source: '(?:verification\\s*code|验证码|Your code is|code is)[：:\\s]*(\\d{6})',
          flags: 'gi',
        },
      ],
    }),
    '333444'
  );
});

test('gmail extractVerificationCode returns the last generic six-digit code', () => {
  const api = createApi();

  assert.equal(api.extractVerificationCode('old code 123456, latest code 654321'), '654321');
});
