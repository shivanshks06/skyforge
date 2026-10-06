// Starting the dashboard tour from anywhere (search, the overview page).
export const TOUR_EVENT = "skyforge:tour";
export const startTour = () => window.dispatchEvent(new Event(TOUR_EVENT));
