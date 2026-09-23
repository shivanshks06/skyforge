import { createContext, useEffect, useState } from "react";
import api from "../services/api";

export const AuthContext=createContext();

export default function AuthProvider({children}){

  const[user,setUser]=useState(null);
  const[loading,setLoading]=useState(true);

  useEffect(()=>{
    const loadUser=async()=>{
      const token=localStorage.getItem("token");

      if(!token){
        setLoading(false);
        return;
      }

      try{
        const res=await api.get("/auth/me");
        setUser(res.data);
      }catch{
        localStorage.removeItem("token");
      }

      setLoading(false);
    };

    loadUser();
  },[]);

  const login=(token,user)=>{
    localStorage.setItem("token",token);
    setUser(user);
  };

  const logout=()=>{
    localStorage.removeItem("token");
    setUser(null);
  };

  return(
    <AuthContext.Provider value={{user,login,logout,loading}}>
      {children}
    </AuthContext.Provider>
  );
}