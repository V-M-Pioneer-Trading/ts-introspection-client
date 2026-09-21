/**
 * @file Startup configuration fails fast, and says which variable.
 */

import {
  IntrospectionConfigError,
  loadIntrospectionConfig,
} from "../src/config";
import { ENV_SECRET, ENV_URL } from "../src/messages";

const good = {
  [ENV_URL]: "http://localhost:3005/auth/v1/introspect",
  [ENV_SECRET]: "a-secret",
};

describe("loadIntrospectionConfig", () => {
  it("returns the URL verbatim, path and all", () => {
    expect(loadIntrospectionConfig(good)).toEqual({
      url: "http://localhost:3005/auth/v1/introspect",
      secret: "a-secret",
    });
  });

  it("accepts the compose form st-gateway uses", () => {
    expect(
      loadIntrospectionConfig({
        ...good,
        [ENV_URL]: "http://auth-service:3005/auth/v1/introspect",
      }).url
    ).toBe("http://auth-service:3005/auth/v1/introspect");
  });

  it.each([
    [ENV_URL, { [ENV_SECRET]: "a-secret" }],
    [ENV_SECRET, { [ENV_URL]: good[ENV_URL] }],
  ])("names %s when it is missing", (name, env) => {
    expect(() => loadIntrospectionConfig(env)).toThrow(IntrospectionConfigError);
    expect(() => loadIntrospectionConfig(env)).toThrow(
      `${name} is required — refusing to start without it`
    );
  });

  it.each([ENV_URL, ENV_SECRET])("names %s when it is blank", (name) => {
    expect(() => loadIntrospectionConfig({ ...good, [name]: "   " })).toThrow(
      `${name} is required`
    );
  });

  it.each([
    "ftp://localhost:3005/auth/v1/introspect",
    "file:///auth/v1/introspect",
    "ws://localhost:3005/auth/v1/introspect",
  ])("rejects the non-http(s) URL %s", (url) => {
    expect(() => loadIntrospectionConfig({ ...good, [ENV_URL]: url })).toThrow(
      /must use http or https/
    );
  });

  it("rejects a URL that is not absolute", () => {
    expect(() =>
      loadIntrospectionConfig({ ...good, [ENV_URL]: "/auth/v1/introspect" })
    ).toThrow(/must be an absolute URL/);
  });

  it("rejects a query string, where a secret should never be", () => {
    expect(() =>
      loadIntrospectionConfig({
        ...good,
        [ENV_URL]: "http://localhost:3005/auth/v1/introspect?secret=hunter2",
      })
    ).toThrow(/no query string/);
  });
});
