import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "automoney — 아뜨랑스 파트너 부업, 링크 하나로 시작",
  description: "아뜨랑스 상품을 내 SNS 에 소개하고, 내 링크로 발생한 구매만큼 매월 수당을 받는 파트너 프로그램. 콘텐츠 생성·예약 발행·성과 분석까지 한 곳에서.",
  openGraph: { title: "automoney — 아뜨랑스 파트너", description: "링크 발급 → SNS 게시 → 구매 발생 → 매월 정산. 부업을 자동화하는 파트너 대시보드.", type: "website" },
};

const STEPS = [
  { n: "01", title: "가입하고 정산 정보 등록", body: "이메일로 가입한 뒤 신분·계좌 정보와 통장 사본을 올립니다. 정보는 암호화되어 저장되고 정산에만 쓰입니다." },
  { n: "02", title: "상품 고르고 내 링크 발급", body: "아뜨랑스 상품 중 소개하고 싶은 것을 고르면 나만의 추적 링크가 만들어집니다. 짧은 주소라 어디에 붙여도 됩니다." },
  { n: "03", title: "SNS 에 올리기", body: "인스타그램·스레드·X·틱톡·블로그에 직접 올려도 되고, 콘텐츠 생성과 예약 발행을 automoney 에 맡겨도 됩니다." },
  { n: "04", title: "실적 확인하고 매월 정산", body: "내 링크로 구매가 생기면 대시보드에 바로 잡힙니다. 한 달 실적은 다음 달에 정산되고 명세서로 남습니다." },
];

const FEATURES = [
  { icon: "🔗", title: "추적 링크", body: "상품별 링크와 클릭 수, 주문 전환을 실시간으로 봅니다. 링크로 시작된 구매만 내 실적으로 잡힙니다." },
  { icon: "✍️", title: "콘텐츠 자동 생성", body: "아뜨랑스 매거진과 상품 정보를 소재로 채널별 게시물 초안을 만듭니다. 광고 표기·금칙 표현은 자동으로 점검됩니다." },
  { icon: "🗓️", title: "예약 발행", body: "원하는 시간대에 자동으로 게시합니다. 매번 조금씩 다른 시각에 올려 자연스럽게 운영됩니다." },
  { icon: "🪟", title: "계정별 브라우저 스페이스", body: "SNS 계정마다 로그인·쿠키가 분리된 공간에서 게시합니다. 여러 계정을 섞이지 않게 운영할 수 있습니다." },
  { icon: "📈", title: "성과 분석", body: "게시 후 24시간·3일·7일 반응과 클릭·주문을 모아, 잘 되는 훅과 시간대를 다음 콘텐츠에 반영합니다." },
  { icon: "💬", title: "텔레그램 알림·명령", body: "게시 승인, 실적 요약, 주간 리포트를 텔레그램으로 받고 명령으로 처리합니다." },
];

const FAQ = [
  { q: "비용이 드나요?", a: "가입과 링크 발급은 무료입니다. 수당은 내 링크로 발생한 구매 금액에 정해진 비율을 곱해 계산되며, 내 요율은 가입 후 대시보드에서 확인할 수 있습니다." },
  { q: "정산은 언제, 어떻게 받나요?", a: "월 단위로 마감해 다음 달에 정산됩니다. 취소·반품이 확정된 뒤 금액이 확정되며, 세금 처리는 지급 주체인 아뜨랑스 기준을 따릅니다. 등록한 계좌로 입금되고 명세서는 대시보드에 남습니다." },
  { q: "SNS 계정이 제한될 위험은 없나요?", a: "하루 게시 한도와 게시 간격을 두고, 첫 로그인은 항상 본인이 직접 합니다. 계정 제한 신호가 감지되면 자동 게시를 즉시 멈춥니다." },
  { q: "컴퓨터를 켜 두어야 하나요?", a: "브라우저로 게시하는 방식은 내 PC 의 데스크톱 앱이 실행 중일 때 동작합니다. 스레드·인스타그램을 API 로 연결하면 PC 없이도 게시됩니다." },
  { q: "콘텐츠는 누가 만드나요?", a: "내 PC 의 AI 도구(Codex)가 초안을 만들고, 품질 점검을 통과한 것만 라이브러리에 들어옵니다. 올리기 전에 직접 고치거나 거절할 수 있습니다." },
  { q: "총판(팀장)도 참여할 수 있나요?", a: "네. 총판은 초대 코드로 팀원을 모집하고 팀원 실적과 총판 수당을 별도 화면에서 확인합니다." },
];

export default function Home() {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)" }}>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="text-xl font-bold" style={{ color: "var(--accent)" }}>automoney</span>
        <nav className="flex items-center gap-2 text-sm">
          <a href="#how" className="hidden px-3 py-2 text-stone-600 hover:text-stone-900 sm:inline">이용 방법</a>
          <a href="#features" className="hidden px-3 py-2 text-stone-600 hover:text-stone-900 sm:inline">기능</a>
          <a href="#faq" className="hidden px-3 py-2 text-stone-600 hover:text-stone-900 sm:inline">자주 묻는 질문</a>
          <Link href="/signin" className="btn-ghost">로그인</Link>
          <Link href="/signup" className="btn-primary">파트너 가입</Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl gap-10 px-6 pb-16 pt-10 lg:grid-cols-2 lg:items-center lg:pt-16">
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-800">아뜨랑스 공식 파트너 프로그램</span>
          <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            좋아하는 옷을 소개하고,
            <br />
            <span style={{ color: "var(--accent)" }}>내 링크로 팔린 만큼</span> 매월 받으세요.
          </h1>
          <p className="max-w-xl text-lg text-stone-600">
            아뜨랑스 상품 링크를 발급받아 인스타그램·스레드·X·틱톡·블로그에 올리면 끝. 콘텐츠 만들기, 예약 게시, 실적 집계, 정산까지 automoney 가 대신합니다.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/signup" className="btn-primary !px-6 !py-3 !text-base">무료로 시작하기</Link>
            <a href="#how" className="btn-ghost !px-6 !py-3 !text-base">어떻게 하나요?</a>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-stone-500">
            <li>✓ 가입·링크 발급 무료</li>
            <li>✓ 실적 실시간 확인</li>
            <li>✓ 매월 명세서 발급</li>
          </ul>
        </div>
        <div className="card relative overflow-hidden !p-0 shadow-lg">
          <div className="border-b border-stone-200 bg-stone-50 px-5 py-3 text-xs text-stone-500">내 대시보드 미리보기</div>
          <div className="grid gap-4 p-5">
            <div className="grid grid-cols-3 gap-3">
              {[["이번 달 클릭", "1,284"], ["주문", "37"], ["예상 수당", "₩412,500"]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{k}</div>
                  <div className="text-lg font-semibold tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-stone-200 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between text-xs text-stone-500"><span>오늘 예약 발행</span><span>3건</span></div>
              {[["스레드 · 10:12", "가을 니트, 뭐 입을까요? 🍂"], ["인스타 릴스 · 13:40", "루즈핏 니트 3가지 코디"], ["X · 19:05", "톤온톤으로 키 커 보이는 법"]].map(([t, c]) => (
                <div key={t} className="flex items-center justify-between border-t border-stone-100 py-2"><span className="text-stone-700">{c}</span><span className="text-xs text-stone-400">{t}</span></div>
              ))}
            </div>
            <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">지난달 정산 ₩386,200 · 9월 25일 입금 예정</div>
          </div>
          <p className="border-t border-stone-100 px-5 py-2 text-[11px] text-stone-400">화면 예시입니다. 실제 수치는 계정과 실적에 따라 다릅니다.</p>
        </div>
      </section>

      <section id="how" className="border-y border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-bold">이용 방법</h2>
          <p className="mt-2 text-stone-600">네 단계면 됩니다. 처음 한 번만 준비하면 이후엔 링크를 올리고 확인하는 일만 남습니다.</p>
          <ol className="mt-8 grid gap-4 md:grid-cols-4">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-xl border border-stone-200 p-5">
                <div className="text-sm font-semibold" style={{ color: "var(--accent)" }}>{s.n}</div>
                <div className="mt-1 font-semibold">{s.title}</div>
                <p className="mt-2 text-sm text-stone-600">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold">부업을 자동화하는 도구</h2>
        <p className="mt-2 text-stone-600">링크만 써도 되고, 원하면 콘텐츠와 게시까지 맡길 수 있습니다.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <div className="text-2xl">{f.icon}</div>
              <div className="mt-2 font-semibold">{f.title}</div>
              <p className="mt-1 text-sm text-stone-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-stone-200 bg-white">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 lg:grid-cols-3">
          <div>
            <h2 className="text-2xl font-bold">정산은 이렇게</h2>
            <p className="mt-2 text-stone-600">투명하게 계산하고, 명세서로 남깁니다.</p>
          </div>
          <ul className="grid gap-3 text-sm text-stone-700 lg:col-span-2 sm:grid-cols-2">
            <li className="rounded-lg border border-stone-200 p-4"><b>내 링크로 시작된 구매만</b> 실적으로 잡힙니다. 클릭 후 일정 기간 안의 주문이 대상입니다.</li>
            <li className="rounded-lg border border-stone-200 p-4"><b>월 단위 마감, 다음 달 정산.</b> 취소·반품이 확정된 뒤 금액이 확정됩니다.</li>
            <li className="rounded-lg border border-stone-200 p-4"><b>정산 정보(KYC) 승인 후 지급.</b> 계좌·통장 사본은 암호화되어 저장됩니다.</li>
            <li className="rounded-lg border border-stone-200 p-4"><b>명세서는 대시보드에서</b> 언제든 확인하고 PDF 로 저장할 수 있습니다.</li>
          </ul>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="text-2xl font-bold">자주 묻는 질문</h2>
        <div className="mt-6 divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {FAQ.map((f) => (
            <details key={f.q} className="group p-5">
              <summary className="cursor-pointer list-none font-medium marker:content-none">
                <span className="mr-2 text-stone-400 group-open:hidden">+</span>
                <span className="mr-2 hidden text-stone-400 group-open:inline">−</span>
                {f.q}
              </summary>
              <p className="mt-3 text-sm text-stone-600">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="rounded-2xl px-8 py-12 text-center text-white" style={{ background: "var(--accent)" }}>
          <h2 className="text-2xl font-bold sm:text-3xl">오늘 링크 하나부터 시작해 보세요</h2>
          <p className="mt-2 text-orange-100">가입은 1분, 첫 링크 발급은 30초면 됩니다.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="inline-flex items-center rounded-lg bg-white px-6 py-3 text-base font-medium text-orange-800 hover:bg-orange-50">파트너 가입</Link>
            <Link href="/signin" className="inline-flex items-center rounded-lg border border-white/40 px-6 py-3 text-base font-medium text-white hover:bg-white/10">로그인</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-xs text-stone-500 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} automoney · 아뜨랑스 파트너 프로그램</span>
          <span>게시물에는 표시광고법에 따라 광고임을 표기합니다. 수당은 아뜨랑스 정산 기준에 따라 지급됩니다.</span>
        </div>
      </footer>
    </main>
  );
}
