import { LoginButtons } from "@/components/login-buttons";

export default function LoginPage() {
  return (
    <main style={{minHeight:"100vh",display:"grid",placeItems:"center",padding:24}}>
      <section className="card" style={{width:"min(520px,100%)"}}>
        <h1>Nexa Code AI</h1>
        <p className="muted">Sign in to keep projects, chats, files and project memory together.</p>
        <LoginButtons />
      </section>
    </main>
  );
}
