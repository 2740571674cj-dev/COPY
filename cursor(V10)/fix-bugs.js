const fs = require('fs');
let content = fs.readFileSync('src/core/llm-gateway.js', 'utf8');
const lines = content.split('\n');

// Bug 1: Fix line 129 (index 128) - double escaped regex
// Current: '\\\\b' should be '\\b', '\\\\s\\\\S' should be '\\s\\S', '\\\\/' should be '\\/'
const line129 = lines[128];
console.log('Line 129 before:', JSON.stringify(line129));
// Replace \\b with \b, \\s\\S with \s\S, \\/ with \/
lines[128] = "      const directRegex = new RegExp('<' + toolName + '\\\\b[^>]*>([\\\\s\\\\S]*?)<\\\\/' + toolName + '>', 'g');";
console.log('Line 129 after:', JSON.stringify(lines[128]));

// Bug 1: Fix line 210 (index 209) - same double escape issue
const line210 = lines[209];
console.log('Line 210 before:', JSON.stringify(line210));
lines[209] = "      const re = new RegExp('<' + toolName + '\\\\b[^>]*>[\\\\s\\\\S]*?<\\\\/' + toolName + '>', 'g');";
console.log('Line 210 after:', JSON.stringify(lines[209]));

// Verify the fix
const fixedLine129 = lines[128];
const m1 = fixedLine129.match(/toolName \+ '(.*?)'/);
if (m1) {
  const chars = Array.from(m1[1]).map(c => c.charCodeAt(0));
  console.log('Line 129 regex part chars:', chars);
  // Should be [92, 98, ...] (single backslash before b)
  if (chars[0] === 92 && chars[1] === 98) {
    console.log('Line 129: FIXED - single backslash before b');
  } else if (chars[0] === 92 && chars[1] === 92 && chars[2] === 98) {
    console.log('Line 129: STILL BROKEN - double backslash before b');
  }
}

content = lines.join('\n');
fs.writeFileSync('src/core/llm-gateway.js', content);
console.log('Bug 1 fix applied.');
