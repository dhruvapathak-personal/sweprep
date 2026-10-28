import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SWE Trainer · Reason clearly',
  description:
    'A focused text-answer study loop. Candidate content awaits human review.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
