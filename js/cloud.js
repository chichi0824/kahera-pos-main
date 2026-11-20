/** Kahera cloud menu client. Configure API_URL after deploying the Worker. */
(function (root) {
  "use strict";
  var API_URL = "https://kahera-menu-api.kahera-menu-api.workers.dev";
  var token = null;

  function request(path, options) {
    if (!API_URL || API_URL.indexOf("YOUR-KAHERA-WORKER") !== -1) {
      return Promise.reject(
        new Error("Cloudflare Worker URL has not been configured yet."),
      );
    }
    options = options || {};
    options.headers = options.headers || {};
    options.headers["Content-Type"] = "application/json";
    if (token) options.headers.Authorization = "Bearer " + token;
    return fetch(API_URL.replace(/\/$/, "") + path, options).then(
      function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!response.ok)
              throw new Error(
                body.error || "Request failed (" + response.status + ").",
              );
            return body;
          });
      },
    );
  }

  root.KaheraCloud = {
    getMenu: function () {
      return request("/api/menu", { method: "GET", cache: "no-store" });
    },
    login: function (password) {
      return request("/api/login", {
        method: "POST",
        body: JSON.stringify({ password: password }),
      }).then(function (body) {
        if (!body.token)
          throw new Error("The server did not return an admin session.");
        token = body.token;
        return true;
      });
    },
    logout: function () {
      token = null;
    },
    isAdmin: function () {
      return !!token;
    },
    saveMenu: function (payload) {
      if (!token)
        return Promise.reject(
          new Error("Please log in as administrator first."),
        );
      return request("/api/menu", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    },
  };
})(typeof window !== "undefined" ? window : this);
