import { useCallback, useEffect, useState } from "react";
import api from "../services/api";
import { AuthContext } from "./authContext.js";

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem("token")));

  const loadUser = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const response = await api.get("/auth/me");
      setUser(response.data);
    } catch (error) {
      if (error.response?.status === 401) {
        localStorage.removeItem("token");
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const token = localStorage.getItem("token");
    if (!token) {
      return undefined;
    }
    api.get("/auth/me")
      .then((response) => {
        if (active) setUser(response.data);
      })
      .catch((error) => {
        if (active && error.response?.status === 401) {
          localStorage.removeItem("token");
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      localStorage.removeItem("token");
      setUser(null);
    };
    window.addEventListener("skyforge:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("skyforge:unauthorized", handleUnauthorized);
  }, []);

  const login = (token, userData) => {
    localStorage.setItem("token", token);
    setUser(userData);
    setLoading(false);
  };

  const logout = () => {
    localStorage.removeItem("token");
    setUser(null);
  };

  const value = {
    user,
    setUser,
    login,
    logout,
    loading,
    loadUser,
    refreshUser: loadUser,
    isGithubConnected: Boolean(user?.github),
    githubAccount: user?.github || null,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
