import { expect } from "vitest";

// ---------------------------------------------------------------- fake Nessie
// Mirrors the live API as verified on 2026-10-24: integer-dollar amounts, transfers without a payee,
// GET transfers returns `id` (not `_id`), empty transfer lists answer 404 with a string.

type Obj = Record<string, unknown>;

export class FakeNessie {
  customers: Obj[] = [];
  accounts: Obj[] = [];
  merchants: Obj[] = [];
  transfers: Obj[] = []; // with payer account in `_payer`
  purchases: Obj[] = [];
  bills: Obj[] = [];
  posts = 0;
  failPostAfter = Infinity; // throw a network error on the Nth POST and later
  private seq = 0;

  private id() {
    return `n${(++this.seq).toString().padStart(6, "0")}`;
  }
  private created(o: Obj) {
    return new Response(JSON.stringify({ code: 201, message: "Created", objectCreated: o }), { status: 201 });
  }
  private ok(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.searchParams.get("key")).toBe("nessie_test");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Obj) : {};
    const parts = url.pathname.split("/").filter(Boolean);
    if (method !== "GET") {
      this.posts++;
      if (this.posts >= this.failPostAfter) throw new TypeError("fetch failed");
    }
    const dollars = (x: unknown) => Math.trunc(Number(x));

    if (parts[0] === "customers" && parts.length === 1) {
      if (method === "GET") return this.ok(this.customers);
      const o = { ...body, _id: this.id() };
      this.customers.push(o);
      return this.created(o);
    }
    if (parts[0] === "customers" && parts[2] === "accounts") {
      if (method === "GET") return this.ok(this.accounts.filter((a) => a.customer_id === parts[1]));
      const o = { ...body, _id: this.id(), customer_id: parts[1] };
      this.accounts.push(o);
      return this.created(o);
    }
    if (parts[0] === "merchants") {
      if (method === "GET") return this.ok(this.merchants);
      const o = { ...body, _id: this.id() };
      this.merchants.push(o);
      return this.created(o);
    }
    if (parts[0] === "accounts" && parts[2] === "transfers") {
      if (method === "GET") {
        const list = this.transfers.filter((t) => t._payer === parts[1]).map(({ _payer, _id, ...t }) => ({ id: _id, ...t }));
        return list.length ? this.ok(list) : this.ok("No transfers found for this account", 404);
      }
      expect(Object.keys(body).sort()).toEqual(["amount", "description", "status", "transaction_date"]);
      const o = { ...body, amount: dollars(body.amount), _id: this.id() };
      this.transfers.push({ ...o, _payer: parts[1] });
      return this.created(o);
    }
    if (parts[0] === "accounts" && parts[2] === "purchases") {
      if (method === "GET") return this.ok(this.purchases.filter((p) => p.payer_id === parts[1]));
      const o = { ...body, amount: dollars(body.amount), _id: this.id(), type: "merchant", payer_id: parts[1] };
      this.purchases.push(o);
      return this.created(o);
    }
    if (parts[0] === "accounts" && parts[2] === "bills") {
      if (method === "GET") return this.ok(this.bills.filter((b) => b.account_id === parts[1]));
      const o = { ...body, payment_amount: Number(body.payment_amount), _id: this.id(), account_id: parts[1] };
      this.bills.push(o);
      return this.created(o);
    }
    if (parts[0] === "accounts" && parts[2] === "deposits") return this.ok([]);
    if (parts[0] === "bills" && parts.length === 2) {
      const bill = this.bills.find((b) => b._id === parts[1]);
      if (!bill) return this.ok("This id does not exist in bills", 404);
      if (method === "PUT") {
        Object.assign(bill, body);
        return this.ok({ code: 202, message: "Accepted bill update", objectUpdated: bill }, 202);
      }
      return this.ok(bill);
    }
    return this.ok({ message: "Missing Authentication Token" }, 403);
  };

  transfersOf(account: string) {
    return this.transfers.filter((t) => t._payer === account);
  }
}

