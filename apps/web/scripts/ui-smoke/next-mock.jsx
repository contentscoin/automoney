/* eslint-disable @next/next/no-img-element */
import React from "react";

export function useSearchParams() { return new URLSearchParams(window.location.search); }
export function usePathname() { return window.location.pathname; }
export function useRouter() { return { push: (url) => { window.location.href = url; }, replace: (url) => { window.location.replace(url); } }; }
export function Link({ href, children, ...props }) { return <a href={typeof href === "string" ? href : href.pathname} {...props}>{children}</a>; }
export function Image({ fill, priority, unoptimized, alt = "", ...props }) {
  void fill; void priority; void unoptimized;
  return <img alt={alt} {...props} />;
}
export default Link;
