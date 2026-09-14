import { chromium, expect } from "@playwright/test";

const baseUrl = process.env.CRV_WEB_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${baseUrl}/?q=Caramelos`, { waitUntil: "networkidle" });
  await page.locator('a[href="/artistas/58"]').click();
  await expect(page).toHaveURL(/\/artistas\/58$/);
  await page.getByRole("link", { name: /Las Paticas De La Abuela/ }).click();
  await expect(page).toHaveURL(/\/discos\/57$/);
  await expect(page.locator("tbody > tr")).toHaveCount(4);
  await expect(page.getByText("Nadando a Través De La Galaxia", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Asier Cazalis", exact: true }).click();
  await expect(page).toHaveURL(/\/personas\/2698$/);
  await expect(page.getByRole("heading", { name: "Asier Cazalis" })).toBeVisible();

  await page.goBack({ waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Mad Box's Studios", exact: true }).first().click();
  await expect(page).toHaveURL(/\/organizaciones\/176$/);
  await expect(page.getByRole("heading", { name: "Mad Box's Studios" })).toBeVisible();

  if (errors.length) throw new Error(errors.join("; "));
} finally {
  await browser.close();
}
