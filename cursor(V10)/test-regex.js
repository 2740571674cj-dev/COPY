const fs = require('fs');
const content = fs.readFileSync('src/core/llm-gateway.js', 'utf8');
const lines = content.split('\n');
const line = lines[128];

// Extract the first string argument in new RegExp('...')
// Find pattern between quotes after toolName + '
const regex = /toolName \+ '([^']*)'/g;
let match;
let partIndex = 0;
while ((match = regex.exec(line)) !== null) {
  partIndex++;
  const part = match[1];
  console.log(`Part ${partIndex}: "${part}"`);
  console.log(`  Length: ${part.length}`);
  console.log(`  Chars: ${Array.from(part).map(c => `${c}(${c.charCodeAt(0)})`).join(' ')}`);
}

// Now test: what regex does the current code produce?
const toolName = 'read_file';
try {
  // Simulate current code by eval-ing the line
  const currentRegex = new RegExp('<' + toolName + '\\\\b[^>]*>([\\\\s\\\\S]*?)<\\\\/' + toolName + '>', 'g');
  console.log('\nCurrent regex (with \\\\\\\\b):', currentRegex.toString());
  console.log('Test match:', currentRegex.test('<read_file><path>x</path></read_file>'));
} catch(e) {
  console.log('Current regex error:', e.message);
}

try {
  const fixedRegex = new RegExp('<' + toolName + '\\b[^>]*>([\\s\\S]*?)<\\/' + toolName + '>', 'g');
  console.log('\nFixed regex (with \\\\b):', fixedRegex.toString());
  console.log('Test match:', fixedRegex.test('<read_file><path>x</path></read_file>'));
} catch(e) {
  console.log('Fixed regex error:', e.message);
}
