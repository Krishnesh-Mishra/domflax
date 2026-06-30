import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'domflax · Next.js + Tailwind example',
  description:
    'Demonstrates the domflax webpack adapter: compile-time DOM flattening and Tailwind class compression.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
