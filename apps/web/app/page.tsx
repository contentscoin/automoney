import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-bold" style={{ color: "var(--accent)" }}>
        automoney
      </h1>
      <p className="text-lg text-stone-700">
        아뜨랑스 상품을 내 SNS 에서 소개하고, 링크로 발생한 구매 실적만큼 매월 수당을 받는 파트너 프로그램입니다.
      </p>
      <div className="flex gap-3">
        <Link href="/signup" className="btn-primary">
          파트너 가입
        </Link>
        <Link href="/signin" className="btn-ghost">
          로그인
        </Link>
      </div>
      <ul className="mt-6 grid gap-3 text-left text-sm text-stone-600 sm:grid-cols-3">
        <li className="card">① 가입 후 정산 정보(신분·계좌·통장사본)를 등록합니다.</li>
        <li className="card">② 상품을 골라 나만의 마케팅 링크를 발급받습니다.</li>
        <li className="card">③ 링크로 구매가 발생하면 대시보드에서 실적과 정산 예정액을 확인합니다.</li>
      </ul>
    </main>
  );
}
