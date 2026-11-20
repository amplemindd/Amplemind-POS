import React, { useEffect, useState } from "react";
import Icon from "../lib/icons";
import { A, navigate, useAuth } from "../lib/store";
const LOGO = process.env.PUBLIC_URL + "/amplemind-logo.png"; // logo file: frontend/public/amplemind-logo.png
const BRAND_NAME = "Amplemind POS";
const BRAND_SUB = "Powered by Amplemind Technologies";
const CIRCLE = (px) => ({ width: px, height: px, minWidth: px, maxWidth: px, padding: 2, background: "#fff", clipPath: "circle(50%)", boxShadow: "none" }); // circle logo (global CSS blocks border-radius)
const FILL = { width: "100%", height: "100%", objectFit: "contain", display: "block" };

export default function Login() {
  const {
    login,
    user
  } = useAuth();

  const [f, setF] = useState({
    email: "",
    password: ""
  });

  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Redirect already logged-in users according to their role.
  useEffect(() => {
    if (user) {
      if (user.role === "waiter") {
        navigate("/waiter");
      } else if (user.role === "cashier") {
        navigate("/admin/pos");
      } else {
        navigate("/admin-dashboard");
      }
    }
  }, [user]);

  const submit = async (e) => {
    e.preventDefault();

    setErr("");
    setBusy(true);

    try {
      const u = await login(
        f.email.trim(),
        f.password
      );

      if (u.role === "waiter") {
        navigate("/waiter");
      } else if (u.role === "cashier") {
        navigate("/admin/pos");
      } else {
        navigate("/admin-dashboard");
      }
    } catch (x) {
      setErr(
        x.message || "Login failed. Please try again."
      );
    } finally {
      setBusy(false);
    }
  };

  const name =
    BRAND_NAME;

  return (
    <main className="lgn">

      <section className="lgn-art">

        <div className="lgn-brand">
          <span className="lgn-logo" style={CIRCLE(54)}>
            {LOGO ? (
              <img
                src={LOGO}
                style={FILL}
                alt=""
              />
            ) : (
              <Icon n="coffee" size={30} />
            )}
          </span>

          <div>
            <b>{String(name).toUpperCase()}</b>
            <small style={{ letterSpacing: ".06em", fontSize: 12 }}>{BRAND_SUB}</small>
          </div>
        </div>

        <div className="lgn-copy">

          <h2>
            Billing, tables and reports in one place.
          </h2>

          <p>
            Sign in to manage your menu, orders, staff,
            expenses and GST.
          </p>

          <ul>
            <li>
              <Icon n="cart" size={18} />
              Fast POS billing with KOT and receipts
            </li>

            <li>
              <Icon n="table" size={18} />
              Live table status and held bills
            </li>

            <li>
              <Icon n="chart" size={18} />
              Sales, tax and expense insights
            </li>

            <li>
              <Icon n="shield" size={18} />
              Role based access and audit logs
            </li>
          </ul>

        </div>

        <small className="lgn-foot">
          © {new Date().getFullYear()} Amplemind Technologies
        </small>

        <i className="lgn-sq a" />
        <i className="lgn-sq b" />
        <i className="lgn-sq c" />

      </section>

      <section className="lgn-form">

        <form
          onSubmit={submit}
          className="lgn-card"
          noValidate
        >

          <div className="lgn-mobile-brand">

            <span className="lgn-logo" style={CIRCLE(44)}>
              {LOGO ? (
                <img
                  src={LOGO}
                style={FILL}
                  alt=""
                />
              ) : (
                <Icon n="coffee" size={26} />
              )}
            </span>

            <b>{name}</b>

          </div>

          <h1>Welcome back</h1>

          <p className="muted">
            Sign in with your admin or staff account.
          </p>

          <label className="lgn-field">

            <span>Email address</span>

            <div className="lgn-in">

              <Icon n="mail" size={18} />

              <input
                type="email"
                autoComplete="username"
                required
                value={f.email}
                onChange={(e) =>
                  setF({
                    ...f,
                    email: e.target.value
                  })
                }
                placeholder="you@example.com"
              />

            </div>

          </label>

          <label className="lgn-field">

            <span>Password</span>

            <div className="lgn-in">

              <Icon n="lock" size={18} />

              <input
                type={show ? "text" : "password"}
                autoComplete="current-password"
                required
                value={f.password}
                onChange={(e) =>
                  setF({
                    ...f,
                    password: e.target.value
                  })
                }
                placeholder="Enter your password"
              />

              <button
                type="button"
                className="lgn-eye"
                onClick={() => setShow(!show)}
                aria-label={
                  show
                    ? "Hide password"
                    : "Show password"
                }
              >
                {show ? "Hide" : "Show"}
              </button>

            </div>

          </label>

          {err && (
            <div className="errbox">
              <span>
                <Icon n="alert" size={16} />
                {err}
              </span>
            </div>
          )}

          <button
            className="lgn-btn"
            type="submit"
            disabled={
              busy ||
              !f.email.trim() ||
              !f.password
            }
          >
            {busy ? "Signing in…" : "Sign In"}

            {!busy && (
              <Icon n="arrowr" size={18} />
            )}
          </button>

        </form>

      </section>

    </main>
  );
}