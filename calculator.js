function calculate(a, b, op) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      if (b === 0) throw new Error('Division by zero');
      return a / b;
    default:
      throw new Error(`Unknown operator: ${op}`);
  }
}

function main() {
  const [a, op, b] = process.argv.slice(2);
  if (a === undefined || op === undefined || b === undefined) {
    console.error('Usage: node calculator.js <number> <op> <number>');
    process.exit(1);
  }
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    console.error('Error: operands must be numbers');
    process.exit(1);
  }
  try {
    console.log(calculate(x, y, op));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { calculate };
