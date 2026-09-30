// Mark + wordmark. The mark swaps to its dark-mode colours through <picture>, independent of any CSS layer.
export function Logo() {
  return (
    <span className="logo">
      <picture>
        <source srcSet="/warren-mark-dark.svg" media="(prefers-color-scheme: dark)" />
        <img src="/warren-mark.svg" alt="" width={26} height={26} />
      </picture>
      warren
    </span>
  );
}
