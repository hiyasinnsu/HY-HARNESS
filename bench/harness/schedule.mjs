export async function runRounds(harnesses, runs, parallel, run) {
  for (let n = 1; n <= runs; n++) {
    const offset = (n - 1) % harnesses.length
    const queue = [...harnesses.slice(offset), ...harnesses.slice(0, offset)]
    const workers = Array.from({ length: Math.min(Math.max(1, parallel), queue.length) }, async () => {
      for (let harness = queue.shift(); harness !== undefined; harness = queue.shift()) await run(harness, n)
    })
    await Promise.all(workers)
  }
}
