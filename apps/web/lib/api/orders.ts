export function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const normalizedCurrency = currency.toUpperCase();
  const amountText = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(amount);
  const currencyNameMap: Record<string, string> = {
    CNY: "元",
    USD: "美元"
  };
  const currencyName = currencyNameMap[normalizedCurrency] ?? normalizedCurrency;
  return `${amountText} ${currencyName}`;
}
