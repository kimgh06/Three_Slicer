import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './App.jsx'
import './styles.css'
// The .step/.stp loader is registered by the routes that can open a file, not here: its `three-slicer-viewer/loaders`
// import drags three.js into whatever chunk holds it, and holding it here put three.js on the landing page.

// ponytail: HashRouter — with static hosting it opens anywhere without server configuration
ReactDOM.createRoot(document.getElementById('root')).render(
  <RouterProvider router={createBrowserRouter(routes)} />
)
