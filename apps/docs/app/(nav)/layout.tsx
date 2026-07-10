import { Navigation } from '@/components/Navigation';

export default function NavLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navigation />
      <main className="lg:pl-64">
        <div className="min-h-screen">
          {children}
        </div>
      </main>
    </>
  );
}
