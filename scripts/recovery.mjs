const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000');
if (!process.env.RECOVERY_SECRET)
  throw new Error('RECOVERY_SECRET is required.');
const once = process.argv.includes('--once');
do {
  try {
    const response = await fetch(new URL('/api/internal/recover', origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RECOVERY_SECRET}` },
      signal: AbortSignal.timeout(80000),
    });
    console.log(
      JSON.stringify({
        event: 'recovery',
        status: response.status,
        at: new Date().toISOString(),
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: 'recovery_unavailable',
        at: new Date().toISOString(),
      }),
    );
  }
  if (!once) await new Promise((resolve) => setTimeout(resolve, 10000));
} while (!once);
