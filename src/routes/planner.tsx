import { createFileRoute } from '@tanstack/react-router'
import CoachWeeklyPlanner from '../components/CoachWeeklyPlanner'

export const Route = createFileRoute('/planner')({
  component: CoachWeeklyPlanner,
})
