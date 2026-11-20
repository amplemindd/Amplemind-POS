import React, { useEffect, useState } from "react";
import Icon from "../lib/icons";
import { api, setToken } from "../lib/api";
import { navigate, useAuth } from "../lib/store";
const LOGO = process.env.PUBLIC_URL + "/amplemind-logo.png"; // logo file: frontend/public/amplemind-logo.png
const BRAND_NAME = "Amplemind Technologies";

export default function WaiterLogin() {
  const { user, can, refresh } = useAuth();
  const [f, setF] = useState({ phone: "", password: "" });
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user && !user.public && can("waiter")) navigate("/waiter");
  }, [user, can]);
  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const d = await api("/waiter/login", { method: "POST", body: f });
      const pm = d.user?.permissions || [];
      if (!pm.includes("waiter") && !pm.includes("*"))
        throw new Error(
          "Login is correct, but the Waiter role has no access. Restart the backend once, or ask the admin to check the Waiter role.",
        );
      setToken(d.token);
      await refresh();
      navigate("/waiter");
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="wl">
      <div className="wl-top">
        <span className="wl-logo">
          {LOGO ? (
            <img src={LOGO} alt="" />
          ) : (
            <Icon n="coffee" size={34} />
          )}
        </span>
        <h1>{BRAND_NAME}</h1>
        <i className="wl-sq a" />
        <i className="wl-sq b" />
      </div>
      <form className="wl-card" onSubmit={submit} noValidate>
        <h2>Waiter Login</h2>
        <p className="muted">Sign in with your mobile number and password.</p>
        <label className="lgn-field">
          <span>Mobile number</span>
          <div className="lgn-in">
            <Icon n="phone" size={18} />
            <input
              id="waiter-phone"
              name="phone"
              inputMode="numeric"
              autoComplete="username"
              maxLength={14}
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value })}
              placeholder="10 digit mobile number"
            />
          </div>
        </label>
        <label className="lgn-field">
          <span>Password</span>
          <div className="lgn-in">
            <Icon n="lock" size={18} />
            <input
              id="waiter-password"
              name="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
              placeholder="Password"
            />
            <button
              type="button"
              className="lgn-eye"
              onClick={() => setShow(!show)}
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        {err && (
          <div className="errbox">
            <span>
              <Icon n="alert" size={16} /> {err}
            </span>
          </div>
        )}
        <button
          className="lgn-btn"
          disabled={busy || f.phone.length < 10 || !f.password}
        >
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </main>
  );
}