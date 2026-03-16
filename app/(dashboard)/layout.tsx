import Sidebar from "@/components/Sidebar";
import AuthGuard from "@/components/AuthGuard";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#050808] text-[#F3F4F4]">
        <div className="pt-24 flex">
          {/* FIXED SIDEBAR */}
          <div className="fixed left-0 top-24 h-[calc(100vh-6rem)] w-64">
            <Sidebar />
          </div>

          {/* SCROLLABLE MAIN CONTENT */}
          <main className="ml-64 flex-1 p-8 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}
